import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";
import { taskAttentionLabel } from "../shared/attention.js";

const fixtures: { root: string; store: Store }[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tinycode-attention-"));
  const store = new Store(join(root, "state.db"));
  const result = { root, store };
  fixtures.push(result);
  store.insertProject({
    id: "p",
    name: "project",
    path: root,
    isGit: false,
    branch: null,
    createdAt: "now",
  });
  store.insertTask({
    id: "t",
    projectId: "p",
    title: "task",
    provider: "pi",
    model: null,
    thinkingLevel: null,
    status: "idle",
    attentionId: null,
    cwd: root,
    worktreePath: null,
    nativeSessionId: null,
    createdAt: "now",
    updatedAt: "now",
  });
  return result;
}
afterEach(async () => {
  for (const { root, store } of fixtures.splice(0)) {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a viewed completion read across metadata updates, repeated events, and restarts", async () => {
  const state = await fixture();
  const { store } = state;
  store.patchTask("t", { status: "running" });
  expect(taskAttentionLabel(store.task("t")!)).toBeNull();
  store.patchTask("t", { status: "complete" });
  const completion = store.task("t")!;
  expect(taskAttentionLabel(completion)).toBe("Unread completion");
  expect(store.markTaskRead("t", completion.attentionId!)).toBe(true);
  expect(store.task("t")?.updatedAt).toBe(completion.updatedAt);
  store.patchTask("t", { model: "new-model", title: "Renamed task" });
  store.patchTask("t", { status: "complete" });
  expect(taskAttentionLabel(store.task("t")!)).toBeNull();
  store.db.close();
  state.store = new Store(join(state.root, "state.db"));
  expect(taskAttentionLabel(state.store.task("t")!)).toBeNull();
});

it("preserves a newer unread completion when an old view acknowledgement arrives late", async () => {
  const state = await fixture();
  state.store.patchTask("t", { status: "running" });
  state.store.patchTask("t", { status: "complete" });
  const first = state.store.task("t")!.attentionId!;
  state.store.patchTask("t", { status: "running" });
  expect(state.store.task("t")!.attentionId).toBeNull();
  state.store.patchTask("t", { status: "complete" });
  const second = state.store.task("t")!.attentionId!;
  expect(second).not.toBe(first);
  expect(state.store.markTaskRead("t", first)).toBe(false);
  state.store.db.close();
  state.store = new Store(join(state.root, "state.db"));
  expect(state.store.task("t")!.attentionId).toBe(second);
  expect(state.store.markTaskRead("t", second)).toBe(true);
  expect(taskAttentionLabel(state.store.task("t")!)).toBeNull();
});

it.each(["failed", "interrupted"] as const)("marks %s work unread until viewed", async (status) => {
  const { store } = await fixture();
  store.patchTask("t", { status: "running" });
  store.patchTask("t", { status });
  const task = store.task("t")!;
  expect(taskAttentionLabel(task)).not.toBeNull();
  store.markTaskRead("t", task.attentionId!);
  expect(taskAttentionLabel(store.task("t")!)).toBeNull();
});

it("keeps approval and input requests visible until answered, even after viewing the task", async () => {
  const { store, root } = await fixture();
  const runtime = new Runtime(store, [], root, () => {});
  for (const input of [false, true]) {
    const answer = runtime.sink(store.task("t")!).ask("Continue?", "Awaiting your response", input);
    const approval = runtime.approvals("t")[0];
    store.markTaskRead("t", "previous-completion");
    expect(taskAttentionLabel(store.task("t")!)).toBe("Needs your attention");
    runtime.answer("t", approval.id, { allow: true });
    await expect(answer).resolves.toEqual({ allow: true });
    expect(taskAttentionLabel(store.task("t")!)).toBeNull();
  }
  runtime.dispose();
});

it("migrates existing completed history quietly and flags interrupted work on restart", async () => {
  const state = await fixture();
  state.store.db.exec("ALTER TABLE tasks DROP COLUMN attention_id");
  state.store.db.exec("UPDATE tasks SET status = 'complete'");
  state.store.db.close();
  state.store = new Store(join(state.root, "state.db"));
  expect(taskAttentionLabel(state.store.task("t")!)).toBeNull();
  state.store.patchTask("t", { status: "running" });
  state.store.db.close();
  state.store = new Store(join(state.root, "state.db"));
  expect(state.store.task("t")!.status).toBe("interrupted");
  expect(taskAttentionLabel(state.store.task("t")!)).toBe("Task interrupted");
});
