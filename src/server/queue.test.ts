import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderInfo, ServerPacket } from "../shared/contracts.js";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";
import { createTask } from "./tasks.js";
import { adapters } from "./adapters/index.js";
import type { Sink } from "./adapters/types.js";

vi.mock("./adapters/thinking.js", () => ({
  thinkingOptions: async () => ({ levels: [], defaultLevel: null }),
}));
const roots: string[] = [];
const stores: Store[] = [];
const runtimes: Runtime[] = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await tick();
  for (const store of stores.splice(0)) if (store.db.open) store.db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(stopWait?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tinycode-queue-"));
  roots.push(root);
  const store = new Store(join(root, "state.db"));
  stores.push(store);
  const task = await createTask(store, root, {
    projectId: null,
    provider: "codex",
    model: null,
    thinkingLevel: null,
    branch: null,
  });
  const provider: ProviderInfo = {
    id: "codex",
    name: "Codex",
    command: "fake",
    available: true,
    capabilities: {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: "native",
      subagents: "native",
    },
  };
  const packets: ServerPacket[] = [];
  const runtime = new Runtime(store, [provider], root, (packet) => packets.push(packet));
  runtimes.push(runtime);
  const runs: { text: string; turn: ReturnType<typeof deferred> }[] = [];
  const steers: { text: string; turn: ReturnType<typeof deferred> }[] = [];
  let sink!: Sink;
  vi.spyOn(adapters.codex, "create").mockImplementation(async (context) => {
    sink = context.sink;
    let active: ReturnType<typeof deferred> | undefined;
    return {
      run(text) {
        const turn = deferred();
        active = turn;
        runs.push({ text, turn });
        return turn.promise;
      },
      steer(text) {
        const turn = deferred();
        steers.push({ text, turn });
        return turn.promise;
      },
      async interrupt() {
        active?.resolve();
        await stopWait;
      },
      dispose() {
        active?.resolve();
        for (const steer of steers) steer.turn.reject(new Error("Stopped"));
      },
    };
  });
  return { root, store, task, runtime, runs, steers, packets, sink: () => sink };
}

it("queues FIFO, deduplicates retries while busy, and removes a message before dispatch", async () => {
  const { task, store, runtime, runs, packets } = await fixture();
  await runtime.send(task, "First", "1");
  await tick();
  await runtime.send(task, "Second", "2");
  await runtime.send(task, "Duplicate", "2");
  await runtime.send(task, "Remove me", "3");
  await runtime.send(task, "Fourth", "4");
  runtime.removeQueued(task.id, "3");
  expect(runs.map((r) => r.text)).toEqual(["First"]);
  expect(store.queue(task.id).map((m) => m.text)).toEqual(["Second", "Fourth"]);
  expect(store.timeline(task.id).items.map((m) => m.text)).toEqual(["First"]);
  runs[0].turn.resolve();
  await tick();
  expect(runs.map((r) => r.text)).toEqual(["First", "Second"]);
  runs[1].turn.resolve();
  await tick();
  expect(runs[2].text).toBe("Fourth");
  runs[2].turn.resolve();
  await tick();
  expect(store.queue(task.id)).toEqual([]);
  expect(store.timeline(task.id).turns).toHaveLength(3);
  expect(packets.filter((p) => p.type === "queue").at(-1)).toMatchObject({ queue: [] });
});

it("a delayed stop acknowledgement cannot dispose or overwrite a newer run", async () => {
  const acknowledgement = deferred();
  const { task, store, runtime, runs } = await fixture(acknowledgement.promise);
  await runtime.send(task, "First", "1");
  await tick();
  const stop = runtime.interrupt(task.id);
  await tick();
  await runtime.send(store.task(task.id)!, "New work", "2");
  await tick();
  acknowledgement.resolve();
  await stop;
  await tick();
  expect(runs).toHaveLength(2);
  expect(store.task(task.id)?.status).toBe("running");
  runs[1].turn.resolve();
  await tick();
  expect(store.task(task.id)?.status).toBe("complete");
});

it("steers into the current turn only after native acceptance, including the completion race", async () => {
  const { task, store, runtime, runs, steers, sink } = await fixture();
  await runtime.send(task, "First", "1");
  await tick();
  sink().add("assistant", "Working");
  await runtime.send(task, "Next turn", "2");
  await runtime.send(task, "Change direction", "3", "steer");
  expect(store.queue(task.id).find((m) => m.id === "3")?.status).toBe("sending");
  expect(() => runtime.removeQueued(task.id, "3")).toThrow("already being delivered");
  expect(store.timeline(task.id).items).toHaveLength(2);
  runs[0].turn.resolve();
  await tick();
  // Do not close this turn or start another until the in-flight native request settles.
  expect(runs).toHaveLength(1);
  steers[0].turn.resolve();
  await tick();
  const messages = store.timeline(task.id).items;
  expect(messages.map((m) => m.text)).toEqual([
    "First",
    "Working",
    "Change direction",
    "Next turn",
  ]);
  expect(messages[0].turnId).toBe(messages[2].turnId);
  expect(messages[2].turnId).not.toBe(messages[3].turnId);
  expect(runs).toHaveLength(2);
});

it("retains rejected steering and never silently sends it as a later turn", async () => {
  const { task, store, runtime, runs, steers } = await fixture();
  await runtime.send(task, "First", "1");
  await tick();
  await runtime.send(task, "Steer me", "2", "steer");
  steers[0].turn.reject(new Error("Native turn already ended"));
  await tick();
  runs[0].turn.resolve();
  await tick();
  expect(store.queue(task.id)[0]).toMatchObject({
    text: "Steer me",
    status: "blocked",
    error: "Native turn already ended",
  });
  expect(runs).toHaveLength(1);
  runtime.resumeQueue(task.id);
  await tick();
  expect(runs[1].text).toBe("Steer me");
  expect(store.queue(task.id)).toEqual([]);
});

it("keeps the queue after stop, failure and restart, then resumes explicitly", async () => {
  const { root, task, store, runtime, runs } = await fixture();
  await runtime.send(task, "First", "1");
  await tick();
  await runtime.send(task, "Second", "2");
  await runtime.interrupt(task.id);
  await tick();
  expect(runs).toHaveLength(1);
  expect(store.queue(task.id)[0].text).toBe("Second");
  runtime.resumeQueue(task.id);
  await tick();
  await runtime.send(task, "Third", "3");
  runs[1].turn.reject(new Error("Native failure"));
  await tick();
  expect(store.task(task.id)?.status).toBe("failed");
  expect(runs).toHaveLength(2);
  runtime.dispose();
  await tick();
  store.db.close();
  const reopened = new Store(join(root, "state.db"));
  stores.push(reopened);
  expect(reopened.queue(task.id).map((m) => m.text)).toEqual(["Third"]);
  expect(reopened.claimRequest("3", task.id)).toBe(false);
});

it("preserves uncertain native delivery after restart without automatically retrying", async () => {
  const { root, store, task } = await fixture();
  store.enqueue({
    id: "uncertain",
    taskId: task.id,
    text: "Check me",
    mode: "steer",
    status: "sending",
    error: null,
    createdAt: "now",
  });
  store.db.close();
  const reopened = new Store(join(root, "state.db"));
  stores.push(reopened);
  expect(reopened.queue(task.id)[0]).toMatchObject({
    status: "blocked",
    error: expect.stringContaining("Check the transcript"),
  });
});

it("delivers the saved order and edited text, excluding deleted messages", async () => {
  const { task, store, runtime, runs, packets } = await fixture();
  await runtime.send(task, "First", "1");
  await tick();
  await runtime.send(task, "Second", "2");
  await runtime.send(task, "Third", "3");
  await runtime.send(task, "Fourth", "4");
  runtime.moveQueued(task.id, "4", "2");
  runtime.editQueued(task.id, "3", "Edited third", "Third");
  runtime.removeQueued(task.id, "2");
  // Retrying the original send cannot overwrite the edited pending message.
  await runtime.send(task, "Third", "3");
  expect(store.queue(task.id).map((m) => m.text)).toEqual(["Fourth", "Edited third"]);
  expect(packets.filter((p) => p.type === "queue").at(-1)).toMatchObject({
    queue: [
      { id: "4", text: "Fourth" },
      { id: "3", text: "Edited third" },
    ],
  });
  runs[0].turn.resolve();
  await tick();
  runs[1].turn.resolve();
  await tick();
  expect(runs.map((run) => run.text)).toEqual(["First", "Fourth", "Edited third"]);
  expect(store.timeline(task.id).items.map((item) => item.text)).toEqual([
    "First",
    "Fourth",
    "Edited third",
  ]);
});

it("migrates existing FIFO queues and persists changes and appends across restart", async () => {
  const { root, store, task } = await fixture();
  for (const id of ["1", "2", "3"])
    store.enqueue({
      id,
      taskId: task.id,
      text: id,
      mode: "queue",
      status: "pending",
      error: null,
      createdAt: "now",
    });
  // Exercise an existing pre-reordering database, not only fresh installations.
  store.db.exec("ALTER TABLE queued_messages DROP COLUMN position");
  store.db.close();
  const migrated = new Store(join(root, "state.db"));
  expect(migrated.queue(task.id).map((message) => message.id)).toEqual(["1", "2", "3"]);
  migrated.moveQueued(task.id, "3", "1");
  migrated.moveQueued(task.id, "1", null);
  migrated.editQueued(task.id, "2", "Edited", "2");
  migrated.removeQueued(task.id, "1");
  migrated.enqueue({
    id: "4",
    taskId: task.id,
    text: "Last",
    mode: "queue",
    status: "pending",
    error: null,
    createdAt: "now",
  });
  migrated.db.close();
  const reopened = new Store(join(root, "state.db"));
  stores.push(reopened);
  expect(reopened.queue(task.id).map((message) => [message.id, message.text])).toEqual([
    ["3", "3"],
    ["2", "Edited"],
    ["4", "Last"],
  ]);
});

it("rejects stale edits, missing move anchors, and cross-task queue mutations", async () => {
  const { store, task, runtime } = await fixture();
  for (const id of ["1", "2", "3"])
    store.enqueue({
      id,
      taskId: task.id,
      text: id,
      mode: "queue",
      status: "pending",
      error: null,
      createdAt: "now",
    });
  runtime.editQueued(task.id, "2", "Updated elsewhere", "2");
  expect(() => runtime.editQueued(task.id, "2", "Stale edit", "2")).toThrow("edited elsewhere");
  expect(() => runtime.editQueued(task.id, "2", "  ", "Updated elsewhere")).toThrow(
    "Write a message",
  );
  runtime.removeQueued(task.id, "1");
  expect(() => runtime.moveQueued(task.id, "3", "1")).toThrow("no longer in the queue");
  expect(() => runtime.moveQueued(task.id, "1", "2")).toThrow("no longer in the queue");
  expect(() => runtime.editQueued(task.id, "1", "Too late", "1")).toThrow("no longer in the queue");
  expect(() => runtime.editQueued("another-task", "2", "Wrong task", "Updated elsewhere")).toThrow(
    "no longer in the queue",
  );
  expect(() => runtime.moveQueued("another-task", "2", null)).toThrow("no longer in the queue");
  runtime.removeQueued("another-task", "2");
  expect(store.queue(task.id).map((message) => message.text)).toEqual(["Updated elsewhere", "3"]);
});

it("uses edits and order for pending native steers while freezing delivery already in flight", async () => {
  const { task, store, runtime, steers } = await fixture();
  await runtime.send(task, "First", "1");
  await tick();
  await runtime.send(task, "In flight", "2", "steer");
  await runtime.send(task, "Third", "3", "steer");
  await runtime.send(task, "Fourth", "4", "steer");
  expect(() => runtime.editQueued(task.id, "2", "Too late", "In flight")).toThrow(
    "already being delivered",
  );
  expect(() => runtime.moveQueued(task.id, "2", null)).toThrow("already being delivered");
  expect(() => runtime.moveQueued(task.id, "4", "2")).toThrow("already being delivered");
  runtime.moveQueued(task.id, "4", "3");
  runtime.editQueued(task.id, "4", "Edited steer", "Fourth");
  expect(store.queue(task.id).map((message) => message.id)).toEqual(["2", "4", "3"]);
  steers[0].turn.resolve();
  await tick();
  expect(steers.map((steer) => steer.text)).toEqual(["In flight", "Edited steer"]);
  steers[1].turn.resolve();
  await tick();
  expect(steers[2].text).toBe("Third");
  steers[2].turn.resolve();
  await tick();
  expect(store.queue(task.id)).toEqual([]);
});
