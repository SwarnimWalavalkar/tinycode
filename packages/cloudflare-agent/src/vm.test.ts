import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVmTools, type VmRuntime, type VmSnapshot } from "./vm-tools.js";
import { CloudflareSandboxVm } from "./vm.js";
import type { Env } from "./env.js";

const sandbox = vi.hoisted(() => ({
  startProcess: vi.fn(),
  killProcess: vi.fn(),
  cleanupCompletedProcesses: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => sandbox }));

function runtime(): VmRuntime {
  return {
    start: vi.fn(async (): Promise<VmSnapshot> => ({ state: "ready", lastUsedAt: "now" })),
    exec: vi.fn(async () => ({ success: true, stdout: "ok", stderr: "", exitCode: 0 })),
    status: vi.fn((): VmSnapshot => ({ state: "absent", lastUsedAt: null })),
    interrupt: vi.fn(async () => {}),
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
  beforeEach(() => {
    vi.clearAllMocks();
    sandbox.killProcess.mockResolvedValue(undefined);
    sandbox.cleanupCompletedProcesses.mockResolvedValue(0);
  });

  function process(
    exit: Promise<{ exitCode: number }> = Promise.resolve({ exitCode: 0 }),
    logs = { stdout: "", stderr: "" },
  ) {
    return {
      id: "process-1",
      waitForExit: vi.fn(() => exit),
      getLogs: vi.fn(async () => logs),
    };
  }

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
    sandbox.startProcess.mockResolvedValue(
      process(Promise.resolve({ exitCode: 1 }), { stdout: "", stderr: "permission denied" }),
    );
    const { vm, snapshot } = fixture({ state: "absent", lastUsedAt: null });

    await expect(vm.start()).rejects.toThrow("permission denied");
    expect(snapshot()).toEqual({ state: "absent", lastUsedAt: null });
  });

  it("waits for the full process group to exit before acknowledging cancellation", async () => {
    let exit!: (value: { exitCode: number }) => void;
    const killed = new Promise<{ exitCode: number }>((resolve) => {
      exit = resolve;
    });
    const running = process(new Promise(() => {}));
    running.waitForExit
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => killed);
    sandbox.startProcess.mockResolvedValue(running);
    const { vm } = fixture({ state: "absent", lastUsedAt: null });
    const controller = new AbortController();
    const command = vm.exec("long-command", "/workspace", 30_000, controller.signal);
    const commandFailure = expect(command).rejects.toThrow();
    await vi.waitFor(() => expect(sandbox.startProcess).toHaveBeenCalled());

    controller.abort();
    let acknowledged = false;
    const interrupt = vm.interrupt().then(() => {
      acknowledged = true;
    });
    await vi.waitFor(() =>
      expect(sandbox.killProcess).toHaveBeenCalledWith("process-1", "SIGKILL"),
    );
    expect(acknowledged).toBe(false);

    exit({ exitCode: 137 });
    await interrupt;
    await commandFailure;
    expect(acknowledged).toBe(true);
  });

  it("kills the process group when a command exceeds its timeout", async () => {
    const running = process(new Promise(() => {}));
    running.waitForExit
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async () => ({ exitCode: 137 }));
    sandbox.startProcess.mockResolvedValue(running);
    const { vm } = fixture({ state: "absent", lastUsedAt: null });

    await expect(vm.exec("long-command", "/workspace", 10)).rejects.toThrow(
      "timed out after 10 ms",
    );
    expect(sandbox.killProcess).toHaveBeenCalledWith("process-1", "SIGKILL");
  });

  it("does not kill a completed process while its logs are being collected", async () => {
    let releaseLogs!: () => void;
    const logs = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      releaseLogs = () => resolve({ stdout: "done", stderr: "" });
    });
    const completed = process();
    completed.getLogs.mockImplementation(() => logs);
    sandbox.startProcess.mockResolvedValue(completed);
    const { vm } = fixture({ state: "absent", lastUsedAt: null });
    const controller = new AbortController();
    const command = vm.exec("quick-command", "/workspace", 30_000, controller.signal);
    await vi.waitFor(() => expect(completed.getLogs).toHaveBeenCalled());

    controller.abort();
    releaseLogs();

    await expect(command).resolves.toMatchObject({ success: true, stdout: "done" });
    expect(sandbox.killProcess).not.toHaveBeenCalled();
  });

  it("does not recreate a permanently destroyed VM", async () => {
    const { vm } = fixture({ state: "destroyed", lastUsedAt: "now" });

    await expect(vm.start()).rejects.toThrow("permanently destroyed");
    await expect(vm.exec("pwd", "/workspace", 1_000)).rejects.toThrow(
      "permanently destroyed",
    );
    expect(sandbox.startProcess).not.toHaveBeenCalled();
  });
});
