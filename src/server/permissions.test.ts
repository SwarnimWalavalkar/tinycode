import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task, ProviderId, ProviderInfo } from "../shared/contracts.js";
import { permissionOptions } from "../shared/permissions.js";
import { Store } from "./db.js";
import { createTask } from "./tasks.js";
import { Runtime } from "./runtime.js";
import { adapters } from "./adapters/index.js";
import { createCodex } from "./adapters/codex.js";
import { createClaude } from "./adapters/claude.js";
import { createPi } from "./adapters/pi.js";
import type { Sink } from "./adapters/types.js";

const native = vi.hoisted(() => ({
  calls: [] as any[],
  launches: [] as string[][],
  claudeOptions: [] as any[],
  response: undefined as Record<string, unknown> | undefined,
  claudeMode: undefined as string | undefined,
  autoError: false,
  prompts: 0,
  disposed: 0,
}));
vi.mock("./adapters/jsonl.js", () => ({
  JsonLines: class {
    onMessage = (_: any) => {};
    constructor(_: string, args: string[]) {
      native.launches.push(args);
    }
    send(message: any) {
      native.calls.push(message);
    }
    dispose() {
      native.disposed++;
    }
    async request(message: any) {
      native.calls.push(message);
      const p = message.params ?? {};
      switch (message.method ?? message.type) {
        case "thread/start":
        case "thread/resume":
          return {
            thread: { id: "native-thread" },
            model: "test",
            approvalPolicy: p.approvalPolicy ?? "on-request",
            approvalsReviewer: p.approvalsReviewer ?? "user",
            sandbox: {
              type:
                (
                  {
                    "read-only": "readOnly",
                    "workspace-write": "workspaceWrite",
                    "danger-full-access": "dangerFullAccess",
                  } as any
                )[p.sandbox] ?? "workspaceWrite",
            },
            ...native.response,
          };
        case "turn/start":
          queueMicrotask(() =>
            this.onMessage({ method: "turn/completed", params: { turn: { status: "completed" } } }),
          );
          return { turn: { id: "turn" } };
        case "get_state":
          return { sessionFile: "native-session" };
        case "prompt":
          queueMicrotask(() => this.onMessage({ type: "agent_end" }));
          return {};
        default:
          return {};
      }
    }
  },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options, prompt }: any) => {
    native.claudeOptions.push(options);
    return {
      close() {},
      async setPermissionMode(mode: string) {
        expect(mode).toBe("auto");
        if (native.autoError) throw new Error("Auto mode unavailable for this model");
      },
      async *[Symbol.asyncIterator]() {
        await prompt[Symbol.asyncIterator]().next();
        native.prompts++;
        yield {
          type: "system",
          subtype: "init",
          permissionMode: native.claudeMode ?? options.permissionMode ?? "default",
          session_id: "native-thread",
        };
        yield { type: "result", is_error: false };
      },
    };
  },
}));
vi.mock("./adapters/thinking.js", () => ({
  thinkingOptions: async () => ({ levels: [], defaultLevel: null }),
}));

const sink: Sink = {
  add: () => "row",
  patch() {},
  delta() {},
  identity() {},
  model() {},
  status() {},
  ask: async () => ({ allow: false }),
};
const roots: string[] = [];
const stores = new Set<Store>();
const runtimes: Runtime[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "tinycode-permissions-"));
  roots.push(root);
  return root;
}
function storeAt(path: string) {
  const store = new Store(path);
  stores.add(store);
  return store;
}
function task(cwd: string, provider: ProviderId, permissionMode?: Task["permissionMode"]): Task {
  return {
    id: "t",
    projectId: null,
    provider,
    permissionMode,
    title: "Task",
    model: null,
    thinkingLevel: null,
    status: "idle",
    attentionId: null,
    cwd,
    nativeSessionId: "native-thread",
    worktreePath: null,
    createdAt: "now",
    updatedAt: "now",
  };
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const store of stores) store.db.close();
  stores.clear();
  vi.restoreAllMocks();
  native.calls.length = native.launches.length = native.claudeOptions.length = 0;
  native.response = undefined;
  native.claudeMode = undefined;
  native.autoError = false;
  native.prompts = 0;
  native.disposed = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([
  ["read-only", "on-request", "read-only", "user"],
  ["workspace-write", "on-request", "workspace-write", "user"],
  ["auto-review", "on-request", "workspace-write", "auto_review"],
  ["full-access", "never", "danger-full-access", "user"],
] as const)(
  "applies Codex %s on start, resume, and following turns, explicitly resetting the reviewer",
  async (mode, approvalPolicy, sandbox, approvalsReviewer) => {
    const cwd = await directory();
    for (const nativeSessionId of [null, "native-thread"]) {
      const session = await createCodex({
        task: { ...task(cwd, "codex", mode), nativeSessionId },
        sink,
        command: "codex",
        dataDir: cwd,
      });
      expect(native.calls.at(-1)).toEqual({
        method: nativeSessionId ? "thread/resume" : "thread/start",
        params: {
          ...(nativeSessionId ? { threadId: nativeSessionId } : {}),
          cwd,
          approvalPolicy,
          sandbox,
          approvalsReviewer,
        },
      });
      await session.run("first");
      await session.run("follow up");
      expect(native.calls.at(-1).params).toMatchObject({
        threadId: "native-thread",
        approvalPolicy,
        approvalsReviewer,
      });
      session.dispose();
    }
  },
);

it("fails before a prompt if Codex ignores auto review or overrides the sandbox", async () => {
  const cwd = await directory();
  for (const response of [
    { approvalsReviewer: undefined },
    { sandbox: { type: "dangerFullAccess" } },
  ]) {
    native.response = response;
    await expect(
      createCodex({
        task: task(cwd, "codex", "auto-review"),
        sink,
        command: "codex",
        dataDir: cwd,
      }),
    ).rejects.toThrow("could not apply");
  }
  expect(native.disposed).toBe(2);
  expect(native.calls.some((m) => m.method === "turn/start")).toBe(false);
});

it("leaves older tasks' native permissions untouched", async () => {
  const cwd = await directory();
  const session = await createCodex({
    task: task(cwd, "codex"),
    sink,
    command: "codex",
    dataDir: cwd,
  });
  expect(native.calls.at(-1).params).toEqual({ threadId: "native-thread", cwd });
  session.dispose();
  const claude = await createClaude({
    task: task(cwd, "claude"),
    sink,
    command: "claude",
    dataDir: cwd,
  });
  await claude.run("hello");
  expect(native.claudeOptions[0]).not.toHaveProperty("permissionMode");
  expect(native.claudeOptions[0]).not.toHaveProperty("allowDangerouslySkipPermissions");
  claude.dispose();
});

it.each(permissionOptions.claude)(
  "passes Claude's $id mode through the SDK while retaining native approval callbacks",
  async ({ id }) => {
    const cwd = await directory();
    const ask = vi.fn(sink.ask);
    const session = await createClaude({
      task: task(cwd, "claude", id),
      sink: { ...sink, ask },
      command: "claude",
      dataDir: cwd,
    });
    await session.run("first");
    await session.run("follow up");
    for (const options of native.claudeOptions) {
      expect(options.permissionMode).toBe(id);
      expect(options.resume).toBe("native-thread");
      expect(options.allowDangerouslySkipPermissions).toBe(
        id === "bypassPermissions" ? true : undefined,
      );
      expect(await options.canUseTool("Bash", { command: "example" })).toMatchObject({
        behavior: "deny",
      });
    }
    expect(ask).toHaveBeenCalledTimes(2);
    session.dispose();
  },
);

it("surfaces Claude's refusal to enter auto mode instead of silently running another mode", async () => {
  const cwd = await directory();
  native.claudeMode = "default";
  const session = await createClaude({
    task: task(cwd, "claude", "auto"),
    sink,
    command: "claude",
    dataDir: cwd,
  });
  await expect(session.run("hello")).rejects.toThrow("could not apply");
  session.dispose();
});

it("checks Claude auto-mode availability before handing over any user prompt", async () => {
  const cwd = await directory();
  native.autoError = true;
  const session = await createClaude({
    task: task(cwd, "claude", "auto"),
    sink,
    command: "claude",
    dataDir: cwd,
  });
  await expect(session.run("do not deliver when auto is unavailable")).rejects.toThrow(
    "Auto mode unavailable",
  );
  expect(native.prompts).toBe(0);
  session.dispose();
});

it.each([
  ["native", []],
  ["read-only-tools", ["--tools", "read,grep,find,ls"]],
  ["no-tools", ["--no-tools"]],
] as const)(
  "passes Pi %s through native CLI flags for both fresh and resumed sessions",
  async (mode, flags) => {
    const cwd = await directory();
    for (const nativeSessionId of [null, "native-session"]) {
      const session = await createPi({
        task: { ...task(cwd, "pi", mode), nativeSessionId },
        sink,
        command: "pi",
        dataDir: cwd,
      });
      expect(native.launches.at(-1)).toEqual([
        "--mode",
        "rpc",
        "--session-dir",
        join(cwd, "pi", "t"),
        ...(nativeSessionId ? ["--session", nativeSessionId] : []),
        ...flags,
      ]);
      session.dispose();
    }
  },
);

it("validates permissions before creating a workspace and persists new tasks' selections", async () => {
  const cwd = await directory();
  const store = storeAt(join(cwd, "state.db"));
  const input = { projectId: null, model: null, thinkingLevel: null, branch: null };
  for (const provider of ["codex", "claude", "pi"] as const) {
    const before = await readdir(cwd);
    await expect(
      createTask(store, cwd, { ...input, provider, permissionMode: "unsupported" }),
    ).rejects.toThrow("Unsupported permissions");
    expect(await readdir(cwd)).toEqual(before);
    const created = await createTask(store, cwd, {
      ...input,
      provider,
      permissionMode: permissionOptions[provider][1].id,
    });
    expect(store.task(created.id)?.permissionMode).toBe(permissionOptions[provider][1].id);
  }
  const defaults = await createTask(store, cwd, { ...input, provider: "claude" });
  expect(defaults.permissionMode).toBe("default");
  store.db.close();
  stores.delete(store);
  const reopened = storeAt(join(cwd, "state.db"));
  expect(reopened.tasks()).toHaveLength(4);
  expect(reopened.task(defaults.id)?.permissionMode).toBe("default");
});

it("migrates old tasks without changing their native permissions or transcripts", async () => {
  const cwd = await directory();
  let store = storeAt(join(cwd, "state.db"));
  store.insertTask(task(cwd, "codex"));
  store.append({ id: "message", taskId: "t", kind: "user", text: "existing work" });
  store.db.exec("ALTER TABLE tasks DROP COLUMN permission_mode");
  store.db.close();
  stores.delete(store);
  store = storeAt(join(cwd, "state.db"));
  expect(store.task("t")).toMatchObject({ nativeSessionId: "native-thread", permissionMode: null });
  expect(store.timeline("t").items[0].text).toBe("existing work");
});

it("rejects active-turn changes, retains native identity, and replaces the cached adapter before the next turn", async () => {
  const cwd = await directory();
  const store = storeAt(join(cwd, "state.db"));
  store.insertTask(task(cwd, "codex", "auto-review"));
  const provider: ProviderInfo = {
    id: "codex",
    name: "Codex",
    command: "codex",
    available: true,
    capabilities: {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: "native",
      subagents: "native",
    },
  };
  const runtime = new Runtime(store, [provider], cwd, () => {});
  runtimes.push(runtime);
  let finish!: () => void;
  const dispose = vi.fn();
  const create = vi.spyOn(adapters.codex, "create").mockImplementation(async () => ({
    run: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    interrupt: async () => {},
    dispose,
  }));
  expect(() => runtime.setPermissions(store.task("t")!, "bypassPermissions")).toThrow(
    "Unsupported permissions",
  );
  await runtime.send(store.task("t")!, "first", "r1");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(() => runtime.setPermissions(store.task("t")!, "full-access")).toThrow(
    "Wait for this turn",
  );
  store.patchTask("t", { status: "waiting" });
  expect(() => runtime.setPermissions(store.task("t")!, "full-access")).toThrow(
    "Wait for this turn",
  );
  finish();
  await vi.waitFor(() => expect(store.task("t")?.status).toBe("complete"));
  const attentionId = store.task("t")!.attentionId;
  runtime.setPermissions(store.task("t")!, "read-only");
  expect(dispose).toHaveBeenCalledOnce();
  expect(store.task("t")).toMatchObject({
    nativeSessionId: "native-thread",
    permissionMode: "read-only",
    attentionId,
  });
  await runtime.send(store.task("t")!, "second", "r2");
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1][0].task).toMatchObject({
    nativeSessionId: "native-thread",
    permissionMode: "read-only",
  });
  finish();
  await vi.waitFor(() => expect(store.task("t")?.status).toBe("complete"));
});
