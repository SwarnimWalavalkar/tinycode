import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVmTools, type VmRuntime, type VmSnapshot } from "./vm-tools.js";
import { CloudflareSandboxVm } from "./vm.js";
import type { Env } from "./env.js";

const sandbox = vi.hoisted(() => ({
  exec: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => sandbox }));

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
  it("keeps commands inside the agent workspace and uses the default timeout", async () => {
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

describe("Cloudflare Sandbox VM", () => {
  beforeEach(() => vi.clearAllMocks());

  function fixture(initial: VmSnapshot) {
    let snapshot = initial;
    const vm = new CloudflareSandboxVm(
      { SANDBOX: {} } as unknown as Env,
      "agent-1",
      () => snapshot,
      (next) => {
        snapshot = next;
      },
    );
    return { vm, snapshot: () => snapshot };
  }

  it("does not report ready when workspace preparation fails", async () => {
    sandbox.exec.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });
    const { vm, snapshot } = fixture({ state: "absent", lastUsedAt: null });

    await expect(vm.start()).rejects.toThrow("permission denied");
    expect(snapshot()).toEqual({ state: "absent", lastUsedAt: null });
  });

  it("does not recreate a permanently destroyed VM", async () => {
    const { vm } = fixture({ state: "destroyed", lastUsedAt: "now" });

    await expect(vm.start()).rejects.toThrow("permanently destroyed");
    await expect(vm.exec("pwd", "/workspace", 1_000)).rejects.toThrow(
      "permanently destroyed",
    );
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
