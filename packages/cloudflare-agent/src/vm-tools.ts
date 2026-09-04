import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export type VmState = "absent" | "ready" | "destroyed";
export interface VmSnapshot {
  state: VmState;
  lastUsedAt: string | null;
}

export interface VmRuntime {
  start(): Promise<VmSnapshot>;
  exec(command: string, cwd: string, timeout: number): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  status(): VmSnapshot;
  destroy(): Promise<VmSnapshot>;
}

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  details: value as Record<string, unknown>,
});

export function createVmTools(vm: VmRuntime): AgentTool<any>[] {
  return [
    {
      name: "vm_start",
      label: "Start Linux VM",
      description:
        "Start this agent's isolated Cloudflare Linux sandbox. It is reused while the container is awake; files are ephemeral after an idle sleep or destroy.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => result(await vm.start()),
    },
    {
      name: "vm_exec",
      label: "Run in Linux VM",
      description:
        "Run a shell command in this agent's isolated Linux sandbox. Starting the VM is automatic when needed.",
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 32_000 }),
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
      }),
      executionMode: "sequential",
      execute: async (_id, input) => {
        const parameters = input as { command: string; cwd?: string; timeout_ms?: number };
        const cwd = parameters.cwd ?? "/workspace";
        if (cwd !== "/workspace" && !cwd.startsWith("/workspace/"))
          throw new Error("VM working directory must be inside /workspace");
        return result(await vm.exec(parameters.command, cwd, parameters.timeout_ms ?? 30_000));
      },
    },
    {
      name: "vm_status",
      label: "Inspect Linux VM",
      description:
        "Report the last known VM lifecycle state. An idle Cloudflare container may have slept since this snapshot and will start fresh on the next command.",
      parameters: Type.Object({}),
      execute: async () => result(vm.status()),
    },
    {
      name: "vm_destroy",
      label: "Destroy Linux VM",
      description:
        "Permanently destroy this agent's VM, including its files and processes. Use only when its workspace is no longer needed.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => result(await vm.destroy()),
    },
  ];
}
