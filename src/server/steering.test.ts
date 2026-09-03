import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodex } from "./adapters/codex.js";
import { createPi } from "./adapters/pi.js";
import { createClaude } from "./adapters/claude.js";
import type { AdapterContext } from "./adapters/types.js";

const native = vi.hoisted(() => ({
  calls: [] as any[],
  processes: [] as any[],
  claude: undefined as any,
}));
vi.mock("./adapters/jsonl.js", () => ({
  JsonLines: class {
    onMessage = (_: any) => {};
    constructor() {
      native.processes.push(this);
    }
    send() {}
    dispose() {}
    async request(message: any) {
      native.calls.push(message);
      if (message.method === "thread/start") return { thread: { id: "thread" } };
      if (message.method === "turn/start") return { turn: { id: "native-turn" } };
      if (message.type === "get_state") return {};
      return {};
    }
  },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt }: any) => {
    let emit!: (value: any) => void;
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "native" };
        while (true) {
          const result: any = await new Promise((resolve) => {
            emit = resolve;
          });
          yield result;
          if (!result.queued_turn_count) break;
        }
      },
      close() {},
    };
    native.claude = {
      prompt: prompt[Symbol.asyncIterator](),
      finish: (queued_turn_count = 0) => emit({ type: "result", queued_turn_count }),
    };
    return stream;
  },
}));
const roots: string[] = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function context(): Promise<AdapterContext> {
  const root = await mkdtemp(join(tmpdir(), "tinycode-native-steering-"));
  roots.push(root);
  return {
    command: "fake",
    dataDir: root,
    task: {
      id: "task",
      projectId: null,
      title: "Task",
      provider: "codex",
      model: null,
      thinkingLevel: null,
      nativeSessionId: null,
      status: "idle",
      attentionId: null,
      cwd: root,
      worktreePath: null,
      createdAt: "now",
      updatedAt: "now",
    },
    sink: {
      add: () => "row",
      patch() {},
      delta() {},
      identity() {},
      model() {},
      status() {},
      ask: async () => ({ allow: false }),
    },
  };
}
afterEach(async () => {
  native.calls.length = 0;
  native.processes.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("Codex guards steering with the exact native turn ID and refuses after completion", async () => {
  const session = await createCodex(await context());
  const run = session.run("First");
  await session.steer!("Correction");
  expect(native.calls.at(-1)).toEqual({
    method: "turn/steer",
    params: {
      threadId: "thread",
      expectedTurnId: "native-turn",
      input: [{ type: "text", text: "Correction" }],
    },
  });
  native.processes[0].onMessage({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  await run;
  await expect(session.steer!("Too late")).rejects.toThrow("ended");
  session.dispose();
});

it("Pi waits for native consumption, not just the queue acknowledgement", async () => {
  const session = await createPi(await context());
  const run = session.run("First");
  let accepted = false;
  const steer = session.steer!("/template").then(() => {
    accepted = true;
  });
  await tick();
  expect(native.calls.at(-1)).toEqual({ type: "steer", message: "/template" });
  native.processes[0].onMessage({ type: "queue_update", steering: ["Expanded input"] });
  await tick();
  expect(accepted).toBe(false);
  native.processes[0].onMessage({ type: "queue_update", steering: [] });
  native.processes[0].onMessage({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "Expanded input" }] },
  });
  await steer;
  expect(accepted).toBe(true);
  native.processes[0].onMessage({ type: "agent_end" });
  await run;
  session.dispose();
});

it("Pi rejects unconsumed input when the run ends and cannot leak it into another turn", async () => {
  const session = await createPi(await context());
  const run = session.run("First");
  const steer = session.steer!("Late input");
  const rejected = expect(steer).rejects.toThrow("before consuming");
  const failed = expect(run).rejects.toThrow("before consuming");
  await tick();
  native.processes[0].onMessage({ type: "agent_end" });
  await rejected;
  await failed;
  await expect(session.run("Next")).rejects.toThrow("before consuming");
  session.dispose();
});

it("Claude sends steering through the live SDK stream and closes unconsumed input", async () => {
  const session = await createClaude(await context());
  const run = session.run("First");
  await tick();
  expect((await native.claude.prompt.next()).value.message.content).toBe("First");
  const steer = session.steer!("Correction");
  const input = (await native.claude.prompt.next()).value;
  await steer;
  expect(input).toMatchObject({
    type: "user",
    message: { content: "Correction" },
    uuid: expect.any(String),
  });
  expect(input).not.toHaveProperty("priority");
  const late = expect(session.steer!("Too late")).rejects.toThrow("closed before accepting");
  native.claude.finish();
  await run;
  await late;
  await expect(session.steer!("Closed")).rejects.toThrow("ended");
  session.dispose();
});

it("Claude keeps consuming its native query while a result reports queued user input", async () => {
  const session = await createClaude(await context());
  let ended = false;
  const run = session.run("First").then(() => {
    ended = true;
  });
  await tick();
  await native.claude.prompt.next();
  const steer = session.steer!("Continuation");
  native.claude.finish(1);
  await tick();
  expect(ended).toBe(false);
  expect((await native.claude.prompt.next()).value.message.content).toBe("Continuation");
  await steer;
  native.claude.finish(0);
  await run;
  expect(ended).toBe(true);
  session.dispose();
});
