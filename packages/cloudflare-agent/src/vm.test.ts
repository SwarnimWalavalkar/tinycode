import { describe, expect, it, vi } from "vitest";
import { createVmTools, type VmRuntime, type VmSnapshot } from "./vm-tools.js";

function runtime(): VmRuntime {
  return {
    start: vi.fn(async (): Promise<VmSnapshot> => ({ state: "ready", lastUsedAt: "now" })),
    exec: vi.fn(async () => ({ success: true, stdout: "ok", stderr: "", exitCode: 0 })),
    status: vi.fn((): VmSnapshot => ({ state: "absent", lastUsedAt: null })),
    destroy: vi.fn(
      async (): Promise<VmSnapshot> => ({ state: "destroyed", lastUsedAt: "now" }),
    ),
  };
}

describe("VM tools", () => {
  it("keeps commands inside the agent workspace and bounds timeouts", async () => {
    const vm = runtime();
    const tool = createVmTools(vm).find((tool) => tool.name === "vm_exec")!;
    await expect(tool.execute("call", { command: "pwd", cwd: "/etc" }, undefined as never))
      .rejects.toThrow("inside /workspace");
    await expect(
      tool.execute("call", { command: "pwd", cwd: "/workspace/../etc" }, undefined as never),
    ).rejects.toThrow("inside /workspace");
    await tool.execute(
      "call",
      { command: "pwd", cwd: "/workspace/project/../src" },
      undefined as never,
    );
    await tool.execute("call", { command: "pwd" }, undefined as never);
    expect(vm.exec).toHaveBeenCalledWith("pwd", "/workspace/src", 30_000, undefined);
    expect(vm.exec).toHaveBeenCalledWith("pwd", "/workspace", 30_000, undefined);
  });

  it("exposes explicit start, status, and destructive cleanup", () => {
    expect(createVmTools(runtime()).map((tool) => tool.name)).toEqual([
      "vm_start",
      "vm_exec",
      "vm_status",
      "vm_destroy",
    ]);
  });
});
