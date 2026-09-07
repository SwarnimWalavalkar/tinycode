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
    exec: vi.fn(async () => ({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    })),
    status: vi.fn((): VmSnapshot => ({ state: "absent", lastUsedAt: null })),
    interrupt: vi.fn(async () => {}),
    destroy: vi.fn(
      async (): Promise<VmSnapshot> => ({
        state: "destroyed",
        lastUsedAt: "now",
      }),
    ),
  };
}

describe("VM tools", () => {
  it("keeps commands inside the agent workspace and uses the default timeout", async () => {
    const vm = runtime();
    const tool = createVmTools(vm).find((tool) => tool.name === "vm_exec")!;
    await expect(
      tool.execute("call", { command: "pwd", cwd: "/etc" }, undefined as never),
    ).rejects.toThrow("inside /workspace");
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
  beforeEach(() => {
    vi.resetAllMocks();
  });
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
  const result = (exitCode = 0, stdout = "", stderr = "") => ({
    success: true,
    stderr: "",
    stdout: JSON.stringify({
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr,
    }),
  });

  it("does not report ready when workspace preparation fails", async () => {
    sandbox.exec.mockResolvedValue(result(1, "", "permission denied"));
    const { vm, snapshot } = fixture({ state: "absent", lastUsedAt: null });
    await expect(vm.start()).rejects.toThrow("permission denied");
    expect(snapshot()).toEqual({ state: "absent", lastUsedAt: null });
  });

  it("waits for supervisor confirmation before acknowledging cancellation", async () => {
    let confirm!: () => void;
    sandbox.exec.mockImplementation((command: string) =>
      command.includes(" stop ")
        ? new Promise((resolve) => {
            confirm = () => resolve({ success: true });
          })
        : new Promise(() => {}),
    );
    const { vm } = fixture({ state: "absent", lastUsedAt: null });
    const controller = new AbortController();
    const failed = expect(
      vm.exec("long-command", "/workspace", 30_000, controller.signal),
    ).rejects.toThrow("interrupted");
    controller.abort();
    let acknowledged = false;
    const interrupt = vm.interrupt().then(() => {
      acknowledged = true;
    });
    await vi.waitFor(() => expect(confirm).toBeDefined());
    expect(acknowledged).toBe(false);
    confirm();
    await interrupt;
    await failed;
    expect(acknowledged).toBe(true);
  });

  it("cancels even while lazy startup has not returned", async () => {
    sandbox.exec.mockImplementation((command: string) =>
      command.includes(" stop ") ? Promise.resolve({ success: true }) : new Promise(() => {}),
    );
    const { vm, snapshot } = fixture({ state: "absent", lastUsedAt: null });
    await expect(vm.exec("long-command", "/workspace", 10)).rejects.toThrow(
      "timed out after 10 ms",
    );
    expect(sandbox.exec.mock.calls[1][0]).toContain(" stop ");
    expect(snapshot().commandPending).toBeUndefined();
  });

  it("does not cancel a completed command", async () => {
    sandbox.exec.mockResolvedValue(result(0, "done"));
    const { vm } = fixture({ state: "absent", lastUsedAt: null });
    const controller = new AbortController();
    await expect(
      vm.exec("quick-command", "/workspace", 30_000, controller.signal),
    ).resolves.toMatchObject({ success: true, stdout: "done" });
    controller.abort();
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a permanently destroyed VM", async () => {
    const { vm } = fixture({ state: "destroyed", lastUsedAt: "now" });
    await expect(vm.start()).rejects.toThrow("permanently destroyed");
    await expect(vm.exec("pwd", "/workspace", 1_000)).rejects.toThrow("permanently destroyed");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
