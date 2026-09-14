import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { runFileTool } from "./file-tools.js";

export type VmState = "absent" | "ready" | "destroyed";
export interface VmSnapshot {
  state: VmState;
  lastUsedAt: string | null;
  /** Persisted before starting any process; cleared only after confirmed exit. */
  commandPending?: boolean;
  commandId?: string;
  commandDeadline?: number;
}

export interface VmRuntime {
  start(signal?: AbortSignal): Promise<VmSnapshot>;
  exec(command: string, cwd: string, timeout: number, signal?: AbortSignal): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  status(): VmSnapshot;
  interrupt(): Promise<void>;
  destroy(): Promise<VmSnapshot>;
}

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  details: value as Record<string, unknown>,
});

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected tool arguments");
  return input as Record<string, unknown>;
}

function workspacePath(value: string): string {
  if (!value.startsWith("/")) throw new Error("VM working directory must be inside /workspace");
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `/${segments.join("/")}`;
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/"))
    throw new Error("VM working directory must be inside /workspace");
  return normalized;
}

export function createVmTools(vm: VmRuntime): AgentTool<any>[] {
  return [
    {
      name: "vm_manage",
      label: "Manage Linux VM",
      description:
        "Manage this task's Linux sandbox: start, status (last known snapshot, not live health), or destroy. Call start before using any file or shell tool. Files are lost after idle sleep. Destroy is permanent; use only with user permission and when its files are no longer needed. Sandbox identity is managed by the runtime.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("destroy")]) }),
      executionMode: "sequential",
      execute: async (_id, input, signal) => {
        if (signal?.aborted) throw new Error("VM operation was interrupted");
        switch (objectInput(input).action) {
          case "start": return result(await vm.start(signal));
          case "status": return result(vm.status());
          case "destroy": return result(await vm.destroy());
          default: throw new Error("Choose start, status, or destroy");
        }
      },
    },
    {
      name: "shell",
      label: "Run in Linux VM",
      description:
        "Run a shell command in this agent's isolated Linux sandbox. Requires vm_manage with action start first. For GitHub accounts, git and gh are already authenticated as the user; use normal HTTPS clone/push and gh pr create commands. Never request or print credentials. Git author identity is configured automatically. After an interrupted push or PR creation, inspect remote state before retrying.",
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 32_000 }),
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
      }),
      executionMode: "sequential",
      execute: async (_id, input, signal) => {
        const parameters = input as { command: string; cwd?: string; timeout_ms?: number };
        const cwd = workspacePath(parameters.cwd ?? "/workspace");
        return result(
          await vm.exec(parameters.command, cwd, parameters.timeout_ms ?? 30_000, signal),
        );
      },
    },
    {
      name: "file_read",
      label: "Read file",
      description: "Read a UTF-8 text file in /workspace. Paths may be workspace-relative or absolute. Requires vm_manage with action start first. Returns up to 200 lines by default and 16 KiB, with a revision and nextOffset for continuation. Use shell for binary files or lines exceeding the byte limit.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      }),
      executionMode: "sequential",
      execute: async (_id, input, signal) => result(await runFileTool(vm, { ...objectInput(input), action: "read" }, signal)),
    },
    {
      name: "file_write",
      label: "Write file",
      description: "Create or edit UTF-8 files in /workspace. Requires vm_manage with action start first. Default replace mode applies edits against the original file: each oldText must match exactly once, and edits must not overlap. All edits are validated before an atomic save. Use mode write with content to create or completely overwrite a file (parent directories are created). Optionally supply the revision from file_read to reject stale edits. Returns a bounded diff. Paths may be workspace-relative or absolute.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("write")])),
        content: Type.Optional(Type.String({ maxLength: 32000 })),
        edits: Type.Optional(Type.Array(Type.Object({
          oldText: Type.String({ minLength: 1, maxLength: 32000 }),
          newText: Type.String({ maxLength: 32000 }),
        }), { minItems: 1, maxItems: 100 })),
        revision: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
      }),
      executionMode: "sequential",
      execute: async (_id, input, signal) => result(await runFileTool(vm, { ...objectInput(input), action: "edit" }, signal)),
    },
  ];
}
