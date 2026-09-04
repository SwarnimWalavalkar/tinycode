import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import type { VmRuntime, VmSnapshot, VmState } from "./vm-tools.js";

const MAX_OUTPUT = 128 * 1024;
const clip = (value: string) =>
  value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n…output truncated`;

export class CloudflareSandboxVm implements VmRuntime {
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

  async start(signal?: AbortSignal) {
    this.assertAvailable();
    const result = await this.sandbox().exec("mkdir -p /workspace", { timeout: 15_000, signal });
    if (!result.success)
      throw new Error(`Failed to prepare the VM workspace: ${clip(result.stderr || result.stdout)}`);
    return this.used("ready");
  }

  async exec(command: string, cwd: string, timeout: number, signal?: AbortSignal) {
    this.assertAvailable();
    const result = await this.sandbox().exec(command, { cwd, timeout, signal });
    this.used("ready");
    return {
      success: result.success,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      exitCode: result.exitCode,
    };
  }

  status() {
    return this.readSnapshot();
  }

  async destroy() {
    await this.sandbox().destroy();
    return this.used("destroyed");
  }
}
