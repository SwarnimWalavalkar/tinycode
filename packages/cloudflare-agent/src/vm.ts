import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import type { VmRuntime, VmSnapshot, VmState } from "./vm-tools.js";

const MAX_OUTPUT = 128 * 1024;
const PROCESS_EXIT_TIMEOUT = 5_000;
const clip = (value: string) =>
  value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n…output truncated`;

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function interrupted(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("VM command was interrupted");
}

export class CloudflareSandboxVm implements VmRuntime {
  private stopActive: ((reason: Error) => Promise<void>) | undefined;

  constructor(
    private env: Env,
    private id: string,
    private readSnapshot: () => VmSnapshot,
    private writeSnapshot: (snapshot: VmSnapshot) => void,
  ) {}

  private sandbox() {
    return getSandbox(this.env.SANDBOX, this.id, {
      enableDefaultSession: false,
      sleepAfter: "10m",
    });
  }

  private used(state: VmState): VmSnapshot {
    const snapshot = { state, lastUsedAt: new Date().toISOString() } satisfies VmSnapshot;
    this.writeSnapshot(snapshot);
    return snapshot;
  }

  private assertAvailable() {
    if (this.readSnapshot().state === "destroyed")
      throw new Error("This agent's VM was permanently destroyed");
  }

  private async run(command: string, cwd: string, timeout: number, signal?: AbortSignal) {
    this.assertAvailable();
    if (signal?.aborted) throw interrupted(signal);
    const sandbox = this.sandbox();
    const process = await sandbox.startProcess(command, { cwd, autoCleanup: false });
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    let stopping: Promise<void> | undefined;
    let stopReason: Error | undefined;
    const stop = (reason: Error) => {
      if (!stopping) {
        stopReason = reason;
        stopping = (async () => {
          await sandbox.killProcess(process.id, "SIGKILL");
          await process.waitForExit(PROCESS_EXIT_TIMEOUT);
        })();
        void stopping.then(
          () => rejectCancelled(stopReason!),
          (failure) =>
            rejectCancelled(
              new Error(`${stopReason!.message}; failed to terminate the VM command: ${error(failure).message}`, {
                cause: failure,
              }),
            ),
        );
      }
      return stopping;
    };
    this.stopActive = stop;
    const onAbort = () => void stop(interrupted(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => void stop(new Error(`VM command timed out after ${timeout} ms`)),
      timeout,
    );
    let cancellationArmed = true;
    const disarmCancellation = () => {
      if (!cancellationArmed) return;
      cancellationArmed = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (this.stopActive === stop) this.stopActive = undefined;
    };
    if (signal?.aborted) onAbort();

    try {
      let completed: { exitCode: number };
      try {
        completed = await Promise.race([process.waitForExit(), cancelled]);
        if (stopping) {
          await stopping;
          return await cancelled;
        }
      } catch (failure) {
        if (stopping) throw failure;
        await stop(error(failure));
        return await cancelled;
      }
      disarmCancellation();
      const logs = await process.getLogs();
      return {
        success: completed.exitCode === 0,
        stdout: clip(logs.stdout),
        stderr: clip(logs.stderr),
        exitCode: completed.exitCode,
      };
    } finally {
      disarmCancellation();
      await sandbox.cleanupCompletedProcesses().catch(() => {});
    }
  }

  async start(signal?: AbortSignal) {
    const result = await this.run("mkdir -p /workspace", "/", 15_000, signal);
    if (!result.success)
      throw new Error(`Failed to prepare the VM workspace: ${clip(result.stderr || result.stdout)}`);
    return this.used("ready");
  }

  async exec(command: string, cwd: string, timeout: number, signal?: AbortSignal) {
    const result = await this.run(command, cwd, timeout, signal);
    this.used("ready");
    return result;
  }

  status() {
    return this.readSnapshot();
  }

  async interrupt() {
    await this.stopActive?.(new Error("VM command was interrupted"));
  }

  async destroy() {
    await this.interrupt();
    await this.sandbox().destroy();
    return this.used("destroyed");
  }
}
