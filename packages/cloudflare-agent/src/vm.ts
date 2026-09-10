import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import type { VmRuntime, VmSnapshot, VmState } from "./vm-tools.js";
import type { Sandbox } from "./sandbox.js";
import { LEGACY_OWNER } from "./ownership.js";

const CONTROL_TIMEOUT = 6_000;
const SUPERVISOR = "python3 /usr/local/lib/tinycode-supervisor.py";
async function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("VM control request timed out; termination is unconfirmed")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export class CloudflareSandboxVm implements VmRuntime {
  // Commit identity is a snapshot for this adapter; credentials are checked on every request.
  private githubIdentity?: { owner: string; name: string; email: string };
  private stopActive: ((reason: Error) => Promise<void>) | undefined;

  constructor(
    private env: Env,
    private id: string,
    private readSnapshot: () => VmSnapshot,
    private writeSnapshot: (snapshot: VmSnapshot) => void,
    private readOwner: () => string = () => LEGACY_OWNER,
  ) {}

  private sandbox() {
    // DO IDs are 64 hex characters; Sandbox names allow at most 63.
    // Base36 preserves all 256 bits (unlike truncation) in at most 50 characters.
    const sandboxId = /^[a-f0-9]{64}$/i.test(this.id)
      ? `tc-${BigInt(`0x${this.id}`).toString(36)}`
      : this.id;
    return getSandbox<Sandbox>(this.env.SANDBOX, sandboxId, {
      enableDefaultSession: false,
      sleepAfter: "10m",
    });
  }

  private used(state: VmState): VmSnapshot {
    const snapshot = {
      state,
      lastUsedAt: new Date().toISOString(),
    } satisfies VmSnapshot;
    this.writeSnapshot(snapshot);
    return snapshot;
  }

  private assertAvailable() {
    if (this.readSnapshot().state === "destroyed")
      throw new Error("This agent's VM was permanently destroyed");
  }

  private async stopCommand(id: string, expires: number) {
    const result = await deadline(
      this.sandbox().exec(`${SUPERVISOR} stop ${id} ${expires}`, {
        timeout: CONTROL_TIMEOUT,
      }),
      CONTROL_TIMEOUT,
    );
    if (!result.success)
      throw new Error("VM termination is unconfirmed; retry Stop before continuing");
  }

  private clearCommand() {
    const { commandPending, commandId, commandDeadline, ...snapshot } = this.readSnapshot();
    this.writeSnapshot(snapshot);
  }

  private async run(command: string, cwd: string, timeout: number, signal?: AbortSignal) {
    this.assertAvailable();
    if (this.stopActive) throw new Error("Wait for the current VM command to finish");
    if (signal?.aborted) throw new Error("VM command was interrupted");
    let githubEnv: Record<string, string> = {};
    const owner = this.readOwner();
    if (owner !== LEGACY_OWNER) {
      await deadline(this.sandbox().bindGithub(owner), CONTROL_TIMEOUT);
      if (this.githubIdentity?.owner !== owner) {
        const account = await deadline(this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("accounts")).profile(owner), CONTROL_TIMEOUT);
        this.githubIdentity = { owner, name: account.name || account.login, email: account.email };
      }
      const account = this.githubIdentity;
      githubEnv = {
        GH_TOKEN: "TINYCODE_GITHUB_CREDENTIAL", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: account.name, GIT_AUTHOR_EMAIL: account.email,
        GIT_COMMITTER_NAME: account.name, GIT_COMMITTER_EMAIL: account.email,
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf", GIT_CONFIG_VALUE_0: "git@github.com:",
        GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf", GIT_CONFIG_VALUE_1: "ssh://git@github.com/",
      };
      if (signal?.aborted) throw new Error("VM command was interrupted");
      if (this.stopActive) throw new Error("Wait for the current VM command to finish");
    }
    const id = crypto.randomUUID();
    const expires = Date.now() + timeout;
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify([command, cwd]))));
    this.writeSnapshot({
      ...this.readSnapshot(),
      commandPending: true,
      commandId: id,
      commandDeadline: expires,
    });
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    let stopping: Promise<void> | undefined;
    const stop = (reason: Error) => {
      if (!stopping) {
        stopping = this.stopCommand(id, expires).then(() => this.clearCommand());
        void stopping.then(() => rejectCancelled(reason), rejectCancelled);
      }
      return stopping;
    };
    this.stopActive = stop;
    const onAbort = () => {
      void stop(new Error("VM command was interrupted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      void stop(new Error(`VM command timed out after ${timeout} ms`));
    }, timeout);
    try {
      // Cancellation is armed before lazy startup. The supervisor also checks the absolute
      // deadline and a cancellation tombstone, so a delayed RPC cannot start cancelled work.
      const operation = this.sandbox().exec(`${SUPERVISOR} run ${id} ${expires} '${payload}'`, {
        timeout: timeout + CONTROL_TIMEOUT,
        env: githubEnv,
      });
      if (signal?.aborted) onAbort();
      const result = await Promise.race([operation, cancelled]);
      if (stopping) {
        await stopping;
        return await cancelled;
      }
      if (!result.success) throw new Error("VM supervisor failed: " + result.stderr.slice(0, 2000));
      const output = JSON.parse(result.stdout) as {
        success: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      };
      this.clearCommand();
      return output;
    } catch (error) {
      if (!stopping) await stop(error instanceof Error ? error : new Error(String(error)));
      return await cancelled;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (this.stopActive === stop) this.stopActive = undefined;
    }
  }

  async start(signal?: AbortSignal) {
    const result = await this.run("mkdir -p /workspace", "/", 15_000, signal);
    if (!result.success)
      throw new Error(
        `Failed to prepare the VM workspace: ${(result.stderr || result.stdout).slice(0, 2000)}`,
      );
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

  async recover() {
    if (!this.readSnapshot().commandPending) return;
    const { commandId, commandDeadline } = this.readSnapshot();
    if (!commandId || !commandDeadline)
      throw new Error(
        "An older VM command has unconfirmed effects; inspect its sandbox before continuing",
      );
    await this.stopCommand(commandId, commandDeadline);
    this.clearCommand();
  }

  async destroy() {
    await this.interrupt();
    await this.sandbox().destroy();
    return this.used("destroyed");
  }
}
