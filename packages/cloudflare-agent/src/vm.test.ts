import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVmTools, type VmRuntime, type VmSnapshot } from "./vm-tools.js";
import { CloudflareSandboxVm } from "./vm.js";
import type { Env } from "./env.js";

const sandbox = vi.hoisted(() => ({
  exec: vi.fn(),
  destroy: vi.fn(),
  bindGithub: vi.fn(),
  ensureTerminalSession: vi.fn(),
  fetch: vi.fn(),
  readWorkspace: vi.fn(),
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
  it("validates the initial command working directory and uses the default timeout", async () => {
    const vm = runtime();
    const tool = createVmTools(vm).find((tool) => tool.name === "shell")!;
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

  it("routes lifecycle actions and rejects invalid or cancelled requests", async () => {
    const vm = runtime();
    const tool = createVmTools(vm).find(tool => tool.name === "vm_manage")!;
    await tool.execute("call", { action: "status" }, undefined as never);
    expect(vm.status).toHaveBeenCalledOnce();
    expect(vm.start).not.toHaveBeenCalled();
    await tool.execute("call", { action: "start" }, undefined as never);
    expect(vm.start).toHaveBeenCalledOnce();
    await tool.execute("call", { action: "destroy" }, undefined as never);
    expect(vm.destroy).toHaveBeenCalledOnce();
    await expect(tool.execute("call", { action: "bogus" }, undefined as never)).rejects.toThrow("Choose");
    await expect(tool.execute("call", { action: "destroy" }, AbortSignal.abort())).rejects.toThrow("interrupted");
    expect(vm.destroy).toHaveBeenCalledOnce();
  });

  it("exposes explicit start, status, and destructive cleanup", () => {
    expect(createVmTools(runtime()).map((tool) => tool.name)).toEqual([
      "vm_manage",
      "shell",
      "file_read",
      "file_write",
    ]);
  });
});

describe("Cloudflare Sandbox VM", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("uses direct filesystem reads without executing shell commands", async () => {
    const { vm } = fixture({ state: "ready", lastUsedAt: null });
    sandbox.readWorkspace.mockResolvedValue(new Response('{"content":"hello"}'));
    expect(await (await vm.readWorkspace("file", "hello.txt")).json()).toEqual({ content: "hello" });
    expect(sandbox.readWorkspace).toHaveBeenCalledWith("file", "hello.txt");
    expect(sandbox.exec).not.toHaveBeenCalled();
    const absent = fixture({ state: "absent", lastUsedAt: null });
    await expect(absent.vm.readWorkspace("tree", "")).rejects.toThrow("not created");
  });

  it("loads explorer files without GitHub setup while retaining command tracking", async () => {
    let snapshot: VmSnapshot = { state: "ready", lastUsedAt: null };
    const snapshots: VmSnapshot[] = [];
    const vm = new CloudflareSandboxVm(
      { SANDBOX: {} } as unknown as Env, "agent-1", () => snapshot,
      next => { snapshot = next; snapshots.push(next); }, () => "github-1",
    );
    sandbox.exec.mockResolvedValue({ success: true, stderr: "", stdout: JSON.stringify({
      success: true, stdout: "file contents", stderr: "", exitCode: 0,
    }) });
    expect((await vm.execWorkspace("read-file", "/workspace", 30000)).stdout).toBe("file contents");
    expect(sandbox.bindGithub).not.toHaveBeenCalled();
    expect(sandbox.exec.mock.calls[0][1].env).toEqual({});
    expect(snapshots.some(value => value.commandPending)).toBe(true);
    expect(snapshot.commandPending).toBeUndefined();
    snapshot = { state: "absent", lastUsedAt: null };
    await expect(vm.execWorkspace("read-file", "/workspace", 30000)).rejects.toThrow("not created");
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
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

  it("automatically binds every new sandbox to its user without passing a real GitHub token", async () => {
    sandbox.exec.mockResolvedValue(result(0, "ok"));
    const profile = vi.fn(async () => ({ name: "Alice", login: "alice", email: "1+alice@users.noreply.github.com" }));
    const env = { SANDBOX: {}, ACCOUNTS: { idFromName: (s: string) => s, get: () => ({ profile }) } } as unknown as Env;
    for (const id of ["first-sandbox", "next-sandbox"]) {
      let snapshot: VmSnapshot = { state: "absent", lastUsedAt: null };
      const vm = new CloudflareSandboxVm(env, id, () => snapshot, (next) => { snapshot = next; }, () => "github-1");
      await vm.start();
      await vm.exec("git clone https://github.com/alice/private.git", "/workspace", 30_000);
      await vm.exec("git status", "/workspace", 30_000);
    }
    expect(sandbox.bindGithub).toHaveBeenCalledTimes(6);
    expect(profile).toHaveBeenCalledTimes(2);
    for (const [, options] of sandbox.exec.mock.calls) {
      expect(options.env).toMatchObject({ GH_TOKEN: "TINYCODE_GITHUB_CREDENTIAL", GIT_AUTHOR_EMAIL: "1+alice@users.noreply.github.com", GIT_TERMINAL_PROMPT: "0" });
    }
  });

  it("rejects all sandbox tools before explicit start without making a sandbox RPC", async () => {
    const { vm } = fixture({ state: "absent", lastUsedAt: null });
    const tools = createVmTools(vm);
    for (const [name, input] of [
      ["shell", { command: "pwd" }],
      ["file_read", { path: "example.txt" }],
      ["file_write", { path: "example.txt", mode: "write", content: "hello" }],
    ] as const) {
      await expect(tools.find(tool => tool.name === name)!.execute("call", input, undefined as never))
        .rejects.toThrow('Call vm_manage with action: "start"');
    }
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.bindGithub).not.toHaveBeenCalled();
    sandbox.exec.mockResolvedValue(result(0, "started"));
    await tools.find(tool => tool.name === "vm_manage")!.execute("start", { action: "start" }, undefined as never);
    await expect(tools.find(tool => tool.name === "shell")!.execute("call", { command: "pwd" }, undefined as never))
      .resolves.toBeDefined();
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
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
    const { vm } = fixture({ state: "ready", lastUsedAt: null });
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

  it("cancels even while the sandbox RPC has not returned", async () => {
    sandbox.exec.mockImplementation((command: string) =>
      command.includes(" stop ") ? Promise.resolve({ success: true }) : new Promise(() => {}),
    );
    const { vm, snapshot } = fixture({ state: "ready", lastUsedAt: null });
    await expect(vm.exec("long-command", "/workspace", 10)).rejects.toThrow(
      "timed out after 10 ms",
    );
    expect(sandbox.exec.mock.calls[1][0]).toContain(" stop ");
    expect(snapshot().commandPending).toBeUndefined();
  });

  it("does not cancel a completed command", async () => {
    sandbox.exec.mockResolvedValue(result(0, "done"));
    const { vm } = fixture({ state: "ready", lastUsedAt: null });
    const controller = new AbortController();
    await expect(
      vm.exec("quick-command", "/workspace", 30_000, controller.signal),
    ).resolves.toMatchObject({ success: true, stdout: "done" });
    controller.abort();
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it("starts the terminal explicitly, reuses its session and strips transport credentials", async () => {
    sandbox.exec.mockResolvedValue(result(0));
    const terminal = vi.fn(async (_request: Request) => new Response("upgrade"));
    sandbox.fetch.mockImplementation(terminal);
    const { vm } = fixture({ state: "absent", lastUsedAt: null });
    const request = new Request("https://internal/terminal", { headers: {
      upgrade: "websocket", cookie: "private", authorization: "Bearer secret", "sec-websocket-protocol": "tinycode.auth.secret",
    } });
    await vm.terminal(request);
    expect(sandbox.ensureTerminalSession).toHaveBeenCalledWith({});
    expect(terminal.mock.calls[0][0].headers.get("upgrade")).toBe("websocket");
    for (const name of ["cookie", "authorization", "sec-websocket-protocol"])
      expect(terminal.mock.calls[0][0].headers.get(name)).toBeNull();
    await vm.terminal(request);
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(2);
    sandbox.ensureTerminalSession.mockRejectedValue(new Error("infrastructure unavailable"));
    await expect(vm.terminal(request)).rejects.toThrow("infrastructure unavailable");
    await vm.closeTerminal();
    expect(sandbox.fetch.mock.calls.at(-1)?.[0].method).toBe("DELETE");
  });

  it("does not recreate a permanently destroyed VM", async () => {
    const { vm } = fixture({ state: "destroyed", lastUsedAt: "now" });
    await expect(vm.start()).rejects.toThrow("permanently destroyed");
    await expect(vm.exec("pwd", "/workspace", 1_000)).rejects.toThrow("permanently destroyed");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});
