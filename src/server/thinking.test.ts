import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderId, ProviderInfo, Task } from "../shared/contracts.js";
import type { Sink } from "./adapters/types.js";
import { createCodex } from "./adapters/codex.js";
import { createClaude } from "./adapters/claude.js";
import { createPi } from "./adapters/pi.js";
import { thinkingOptions } from "./adapters/thinking.js";
import { modelCatalog } from "./adapters/models.js";
import { adapters } from "./adapters/index.js";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";

const native = vi.hoisted(() => ({
  calls: [] as any[],
  launches: [] as string[][],
  claudeOptions: [] as any[],
  processes: [] as { onMessage: (message: any) => void }[],
}));
vi.mock("./adapters/jsonl.js", () => ({
  JsonLines: class {
    onMessage = (_: any) => {};
    constructor(_: string, args: string[]) {
      native.launches.push(args);
      native.processes.push(this);
    }
    send() {}
    dispose() {}
    async request(message: any) {
      native.calls.push(message);
      switch (message.method ?? message.type) {
        case "model/list":
          return {
            data: [
              {
                id: "test-model",
                model: "test-model",
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                  { reasoningEffort: "ultra" },
                ],
              },
            ],
          };
        case "config/read":
          return { config: { model_reasoning_effort: "high" } };
        case "thread/start":
        case "thread/resume":
          return { thread: { id: "native-thread" }, model: "test-model" };
        case "turn/start":
          queueMicrotask(() =>
            this.onMessage({ method: "turn/completed", params: { turn: { status: "completed" } } }),
          );
          return { turn: { id: "turn" } };
        case "get_available_thinking_levels":
          return { levels: ["off", "low", "high", "max"] };
        case "get_state":
          return {
            model: { provider: "test", id: "model" },
            thinkingLevel: "high",
            sessionFile: "native-session",
          };
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
  query: ({ options }: any) => {
    native.claudeOptions.push(options);
    return {
      close() {},
      supportedModels: async () => [
        {
          value: "sonnet",
          resolvedModel: "claude-test",
          supportedEffortLevels: ["low", "high", "max"],
          supportsAutoMode: true,
        },
        { value: "haiku", supportsEffort: false },
      ],
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-test",
          session_id: "native-thread",
        };
        yield { type: "result", is_error: false };
      },
    };
  },
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
const provider = (id: ProviderId): ProviderInfo => ({
  id,
  name: id,
  command: `fake-${id}`,
  available: true,
  capabilities: {
    resume: true,
    steer: false,
    interrupt: true,
    approvals: "native",
    subagents: "native",
  },
});
const task = (cwd: string): Task => ({
  id: "t",
  projectId: "p",
  title: "task",
  provider: "codex",
  model: "test-model",
  thinkingLevel: "high",
  status: "idle",
  attentionId: null,
  cwd,
  worktreePath: null,
  nativeSessionId: "native-thread",
  createdAt: "now",
  updatedAt: "now",
});
const roots: string[] = [];
const stores: Store[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "tinycode-thinking-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  native.calls.length = 0;
  native.launches.length = 0;
  native.claudeOptions.length = 0;
  native.processes.length = 0;
  for (const store of stores.splice(0)) store.db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("uses native per-model effort options and discovers Pi levels without a prompt or saved session", async () => {
  const cwd = await directory();
  expect(await thinkingOptions(provider("codex"), cwd, "test-model")).toEqual({
    levels: ["low", "high", "ultra"],
    defaultLevel: "high",
  });
  expect(await thinkingOptions(provider("claude"), cwd, "claude-test")).toEqual({
    levels: ["low", "high", "max"],
    defaultLevel: null,
  });
  expect(await thinkingOptions(provider("claude"), cwd, "haiku")).toEqual({
    levels: [],
    defaultLevel: null,
  });
  const catalog = await modelCatalog(provider("claude"), cwd);
  expect(catalog.models.find((m) => m.id === "sonnet")?.supportsAutoMode).toBe(true);
  expect(catalog.models.find((m) => m.id === "haiku")?.supportsAutoMode).toBe(false);
  expect(await thinkingOptions(provider("pi"), cwd, "test/model")).toEqual({
    levels: ["off", "low", "high", "max"],
    defaultLevel: "high",
  });
  expect(native.launches.at(-1)).toEqual([
    "--mode",
    "rpc",
    "--no-session",
    "--model",
    "test/model",
  ]);
  expect(native.calls.some((c) => c.type === "prompt" || c.method === "turn/start")).toBe(false);
});

it("passes thinking effort to Codex resume and each turn without losing the native thread", async () => {
  const cwd = await directory();
  const session = await createCodex({ task: task(cwd), sink, command: "fake", dataDir: cwd });
  await session.run("hello");
  expect(native.calls.find((c) => c.method === "thread/resume")?.params).toMatchObject({
    threadId: "native-thread",
    config: { model_reasoning_effort: "high" },
  });
  expect(native.calls.find((c) => c.method === "turn/start")?.params).toMatchObject({
    threadId: "native-thread",
    effort: "high",
  });
  session.dispose();
});

it("passes Claude effort and Pi thinking flags through their native adapters", async () => {
  const cwd = await directory();
  const context = { task: task(cwd), sink, command: "fake", dataDir: cwd };
  const claude = await createClaude(context);
  await claude.run("hello");
  expect(native.claudeOptions.at(-1)).toMatchObject({ effort: "high", resume: "native-thread" });
  claude.dispose();
  const pi = await createPi(context);
  expect(native.launches.at(-1)).toEqual(
    expect.arrayContaining(["--thinking", "high", "--session", "native-thread"]),
  );
  await pi.run("hello");
  pi.dispose();
});

it("projects Pi thinking and text in native block order without duplicating completed output", async () => {
  const cwd = await directory();
  const rows: { kind: string; text: string; status?: string }[] = [];
  const projected: Sink = {
    ...sink,
    add(kind, text, extra) {
      rows.push({ kind, text, status: extra?.status });
      return String(rows.length - 1);
    },
    delta(id, text) {
      rows[Number(id)].text += text;
    },
    patch(id, patch) {
      Object.assign(rows[Number(id)], patch);
    },
  };
  const pi = await createPi({ task: task(cwd), sink: projected, command: "fake", dataDir: cwd });
  const emit = (message: any) => native.processes.at(-1)!.onMessage(message);
  emit({ type: "message_start", message: { role: "assistant" } });
  for (const [contentIndex, kind, text] of [
    [0, "thinking", "Inspect the files"],
    [1, "text", "Here is the answer"],
  ] as const) {
    emit({
      type: "message_update",
      assistantMessageEvent: { type: `${kind}_start`, contentIndex },
    });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: `${kind}_delta`, contentIndex, delta: text },
    });
  }
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the files" },
        { type: "text", text: "Here is the answer" },
      ],
    },
  });
  expect(rows).toEqual([
    { kind: "thought", text: "Inspect the files", status: "complete" },
    { kind: "assistant", text: "Here is the answer", status: "complete" },
  ]);
  pi.dispose();
});

it("validates changes, preserves identity, resets on model changes, and rejects edits during a turn", async () => {
  const cwd = await directory();
  const store = new Store(join(cwd, "state.db"));
  stores.push(store);
  store.insertProject({
    id: "p",
    name: "project",
    path: cwd,
    isGit: false,
    branch: null,
    createdAt: "now",
  });
  store.insertTask(task(cwd));
  const runtime = new Runtime(store, [provider("codex")], cwd, () => {});
  await expect(runtime.setThinking(store.task("t")!, "invalid")).rejects.toThrow(
    "does not support",
  );
  await runtime.setThinking(store.task("t")!, "low");
  expect(store.task("t")).toMatchObject({ thinkingLevel: "low", nativeSessionId: "native-thread" });
  runtime.setModel(store.task("t")!, "other-model");
  expect(store.task("t")?.thinkingLevel).toBeNull();
  runtime.setModel(store.task("t")!, "test-model");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const create = vi
    .spyOn(adapters.codex, "create")
    .mockResolvedValue({ run: () => pending, interrupt: async () => {}, dispose: finish });
  await runtime.send(store.task("t")!, "hello", "request");
  await expect(runtime.setThinking(store.task("t")!, "low")).rejects.toThrow("Wait for this turn");
  await vi.waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0].task.thinkingLevel).toBe("high");
  finish();
  await vi.waitFor(() => expect(store.task("t")?.status).toBe("complete"));
  runtime.dispose();
});
