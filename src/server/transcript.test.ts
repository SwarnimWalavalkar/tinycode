import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderInfo, TimelineItem, Turn } from "../shared/contracts.js";
import type { Sink } from "./adapters/types.js";
import {
  activityGroups,
  activityActions,
  activityLabel,
  completedTurn,
  transcriptTurns,
  workLabel,
} from "../shared/transcript.js";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";
import { createTask } from "./tasks.js";
import { adapters } from "./adapters/index.js";

vi.mock("./adapters/thinking.js", () => ({
  thinkingOptions: async () => ({ levels: [], defaultLevel: null }),
}));
const roots: string[] = [];
const stores: Store[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const store of stores.splice(0)) store.db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const row = (
  id: string,
  kind: TimelineItem["kind"],
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({
  id,
  kind,
  taskId: "task",
  text: id,
  seq: 1,
  createdAt: "2026-09-03T00:00:00.000Z",
  ...extra,
});

it("groups adjacent activity without swallowing commentary or the final response", () => {
  const items = [
    row("u", "user"),
    row("read", "tool", { title: "Read" }),
    row("search", "tool", { title: "Grep" }),
    row("comment", "assistant"),
    row("thought", "thought"),
    row("edit", "tool", { title: "Edit" }),
    row("final-1", "assistant"),
    row("final-2", "assistant"),
    row("error", "error"),
  ];
  expect(activityGroups(items).map((group) => group.items.map((item) => item.id))).toEqual([
    ["u"],
    ["read", "search"],
    ["comment"],
    ["thought", "edit"],
    ["final-1"],
    ["final-2"],
    ["error"],
  ]);
  const split = completedTurn(items);
  expect(split.work.map((item) => item.id)).toEqual([
    "read",
    "search",
    "comment",
    "thought",
    "edit",
  ]);
  expect(split.visible.map((item) => item.id)).toEqual(["u", "final-1", "final-2", "error"]);
  expect(activityLabel(items.slice(1, 3), false)).toBe("Read files, searched");
  expect(activityLabel([row("t", "tool", { title: "Bash", status: "running" })], true)).toBe(
    "Running commands",
  );
});

it("keeps partial pages and old transcripts in separate turns and ignores empty assistant placeholders", () => {
  const turn: Turn = {
    id: "turn-a",
    taskId: "task",
    status: "complete",
    startedAt: "2026-09-03T00:00:00Z",
    finishedAt: "2026-09-03T00:02:07Z",
  };
  const items = [
    row("tool", "tool", { turnId: turn.id }),
    row("empty", "assistant", { turnId: turn.id, text: "" }),
    row("tool2", "tool", { turnId: turn.id }),
    row("u", "user"),
    row("answer", "assistant"),
  ];
  const groups = transcriptTurns(items, [turn]);
  expect(groups).toHaveLength(2);
  expect(groups[0].turn).toEqual(turn);
  expect(activityGroups(groups[0].items)).toHaveLength(1);
  expect(workLabel(groups[0].turn)).toBe("Worked for 2m 7s");
  expect(workLabel(groups[1].turn)).toBe("Worked");
  expect(completedTurn(groups[1].items).work).toEqual([]);
});

it("shows native command actions as readable file and search rows, with raw commands preserved", () => {
  const item = row("commands", "tool", {
    detail: JSON.stringify({
      commandActions: [
        {
          type: "read",
          name: "App.tsx",
          path: "src/client/App.tsx",
          command: "sed -n '1,80p' src/client/App.tsx",
        },
        { type: "search", query: "transcript", path: "src", command: "rg transcript src" },
        { type: "listFiles", path: ".", command: "ls" },
        { type: "unknown", command: "pnpm check" },
      ],
    }),
  });
  expect(activityActions(item)).toEqual([
    { type: "read", label: "Read", target: "App.tsx", path: "src/client/App.tsx" },
    { type: "search", label: "Searched for transcript in", target: "src", path: "src" },
    { type: "list", label: "Listed files in", target: ".", path: "." },
    { type: "command", label: "Ran", target: "pnpm check" },
  ]);
  expect(
    activityActions(
      row("read", "tool", { title: "Read", detail: '{"file_path":"src/client/state.ts"}' }),
    )[0].target,
  ).toBe("state.ts");
  expect(
    activityActions(row("custom", "tool", { title: "Custom extension", detail: "Not JSON" }))[0]
      .label,
  ).toBe("Custom extension");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tinycode-transcript-"));
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
      steer: false,
      interrupt: true,
      approvals: "native",
      subagents: "native",
    },
  };
  const runtime = new Runtime(store, [provider], root, () => {});
  runtimes.push(runtime);
  return { root, store, task, runtime };
}

it("records each accepted turn, including follow-ups through a reused native session", async () => {
  const { root, store, task, runtime } = await fixture();
  let sink!: Sink;
  let finish!: () => void;
  const create = vi.spyOn(adapters.codex, "create").mockImplementation(async (context) => {
    sink = context.sink;
    return {
      run: async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      interrupt: async () => finish(),
      dispose() {},
    };
  });
  for (const request of ["first", "second"]) {
    await runtime.send(store.task(task.id)!, request, request);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    sink.add("tool", "output", { title: "Read", status: "complete" });
    const response = sink.add("assistant", "", { status: "running" });
    sink.delta(response, "answer");
    finish();
    await vi.waitFor(() => expect(store.task(task.id)?.status).toBe("complete"));
    finish = undefined!;
  }
  expect(create).toHaveBeenCalledTimes(1);
  await runtime.send(store.task(task.id)!, "duplicate", "second");
  const page = store.timeline(task.id);
  expect(page.turns).toHaveLength(2);
  expect(new Set(page.items.map((item) => item.turnId)).size).toBe(2);
  expect(page.items.filter((item) => item.kind === "assistant").map((item) => item.text)).toEqual([
    "answer",
    "answer",
  ]);
  expect(page.turns.every((turn) => turn.finishedAt && turn.status === "complete")).toBe(true);
  expect(store.timeline(task.id, undefined, 1).turns).toHaveLength(1);
  runtime.dispose();
  store.db.close();
  const reopened = new Store(join(root, "state.db"));
  stores[stores.indexOf(store)] = reopened;
  expect(reopened.timeline(task.id).turns).toEqual(page.turns);
});

it("preserves a failed turn and does not invent a duration after an unclean restart", async () => {
  const { root, store, task, runtime } = await fixture();
  vi.spyOn(adapters.codex, "create").mockRejectedValue(new Error("Native startup failed"));
  await runtime.send(task, "hello", "request");
  await vi.waitFor(() => expect(store.task(task.id)?.status).toBe("failed"));
  expect(store.timeline(task.id).turns[0]).toMatchObject({
    status: "failed",
    finishedAt: expect.any(String),
  });
  const unfinished = store.startTurn(task.id);
  store.append({
    id: "interrupted",
    taskId: task.id,
    turnId: unfinished.id,
    kind: "thought",
    text: "Partial work",
  });
  store.db.close();
  const reopened = new Store(join(root, "state.db"));
  stores[stores.indexOf(store)] = reopened;
  const turn = reopened.timeline(task.id).turns.find((turn) => turn.id === unfinished.id)!;
  expect(turn).toMatchObject({ status: "interrupted", finishedAt: null });
  expect(workLabel(turn)).toBe("Work interrupted");
});
