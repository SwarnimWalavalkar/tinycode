import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { Env } from "./env.js";
import { TaskStore } from "./task-store.js";
import { HttpError, internal } from "./http.js";
import { authorized, sessionToken } from "./auth.js";

const fakes = vi.hoisted(() => ({
  createAgent: vi.fn(),
  listProcesses: vi.fn(async () => []),
  killProcess: vi.fn(),
  instances: [] as any[],
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox: () => ({
    listProcesses: fakes.listProcesses,
    killProcess: fakes.killProcess,
  }),
}));
vi.mock("./models.js", async (original) => ({
  ...(await original<object>()),
  createPiAgent: fakes.createAgent,
}));
import { DurablePiAgent } from "./agent.js";
import { TaskDirectory } from "./directory.js";
import worker from "./index.js";

function context() {
  const db = new Database(":memory:");
  let alarm: number | null = null;
  const sockets: any[] = [];
  const storage = {
    sql: {
      exec(query: string, ...args: any[]) {
        if (!args.length && query.includes(";")) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const statement = db.prepare(query);
        const rows = statement.reader
          ? statement.all(...args)
          : (statement.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  return {
    storage,
    sockets,
    id: { toString: () => "do-task-1" },
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => unknown) => fn(),
    waitUntil: () => {},
  } as unknown as DurableObjectState & { sockets: any[] };
}

function fakeAgent() {
  let listener: (event: any) => Promise<void>;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const state = { messages: [] as any[], errorMessage: undefined };
  const emit = async (event: any) => {
    if (event.type === "message_end") state.messages.push(event.message);
    await listener(event);
  };
  const agent = {
    state,
    subscribe: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
    prompt: vi.fn(async (text: string) => {
      await emit({
        type: "message_end",
        message: { role: "user", content: text, timestamp: Date.now() },
      });
      await emit({ type: "message_start", message: { role: "assistant" } });
      await emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "cloud answer",
        },
      });
      await gate;
      await emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "cloud answer",
        },
      });
      await emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "cloud answer" }],
          stopReason: "stop",
        },
      });
    }),
    steer: vi.fn(),
    abort: vi.fn(() => finish()),
    finish,
    emit,
  };
  fakes.instances.push(agent);
  return agent;
}
function fixture() {
  const ctx = context();
  const publish = vi.fn(async (request: Request) =>
    new URL(request.url).pathname === "/claim"
      ? Response.json([])
      : Response.json({ ok: true }),
  );
  const env = {
    CLOUDFLARE_API_TOKEN: "test",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    TINYCODE_AGENT_TOKEN: "a".repeat(32),
    DIRECTORY: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: publish }),
    },
  } as unknown as Env;
  const agent = new DurablePiAgent(ctx, env);
  return { ctx, env, agent, publish, store: new TaskStore(ctx.storage) };
}
async function init(agent: DurablePiAgent) {
  expect(
    (
      await agent.fetch(
        internal("/init", {
          id: "task-1",
          model: "openai/gpt-5.4",
          permissionMode: "native",
        }),
      )
    ).status,
  ).toBe(200);
}
beforeEach(() => {
  vi.clearAllMocks();
  fakes.instances.length = 0;
  fakes.createAgent.mockImplementation(fakeAgent);
});

describe("cloud-authoritative tasks", () => {
  it("uses the connected account's Go default when task creation omits a model", async () => {
    const { env, agent, store } = fixture();
    env.TINYCODE_AUTH_SECRET = "s".repeat(32);
    const goStatus = vi.fn(async () => ({ connected: true, enabled: true }));
    const goKey = vi.fn(async () => "test-go-key");
    env.ACCOUNTS = { idFromName: (id: string) => id, get: () => ({ goStatus, goKey }) } as any;
    const response = await agent.fetch(internal("/init", { id: "go-task", createdBy: "github-1" }));
    expect(response.status).toBe(200);
    expect(store.task().model).toBe("opencode-go/glm-5.3-flash");
    expect(goStatus).toHaveBeenCalledWith("github-1");
    expect(goKey).toHaveBeenCalledWith("github-1");
  });

  it("does not persist ownership when a Go key is disconnected", async () => {
    const { env, agent, store } = fixture();
    env.ACCOUNTS = { idFromName: (id: string) => id, get: () => ({
      goKey: async () => { throw new HttpError(409, "Connect OpenCode Go"); },
    }) } as any;
    const response = await agent.fetch(internal("/init", { id: "invalid-task", createdBy: "github-1", model: "opencode-go/glm-5.3-flash" }));
    expect(response.status).toBe(409);
    expect(store.get("ownership")).toBeUndefined();
    expect(store.get("task")).toBeUndefined();
  });

  it("retains workspace, creator, and session GitHub identity across reload and repeated init", async () => {
    const { ctx, env, agent, store } = fixture();
    const ownership = { workspaceId: "personal-github-1", createdBy: "github-1", githubAccountId: "github-1" };
    expect((await agent.fetch(internal("/init", { id: "stable-task", model: "openai/gpt-5.4", ...ownership }))).status).toBe(200);
    expect(store.get("ownership")).toEqual(ownership);
    const restored = new DurablePiAgent(ctx, env);
    expect((await restored.fetch(internal("/init", { id: "stable-task", workspaceId: "personal-github-2", createdBy: "github-2", githubAccountId: "github-2" }))).status).toBe(200);
    expect(store.get("ownership")).toEqual(ownership);
    expect(store.task().id).toBe("stable-task");
  });

  it("persists acceptance before dispatch, survives reconstruction, and completes without any client", async () => {
    const { agent, ctx, env, store } = fixture();
    await init(agent);
    const sent = await agent.fetch(
      internal("/send", { requestId: "request-1", text: "hello" }),
    );
    expect(await sent.json()).toEqual({ ok: true, runId: "request-1" });
    expect(fakes.createAgent).not.toHaveBeenCalled();
    expect(await ctx.storage.getAlarm()).not.toBeNull();
    const restored = new DurablePiAgent(ctx, env);
    await restored.alarm();
    await vi.waitFor(() =>
      expect(fakes.instances[0]?.prompt).toHaveBeenCalledWith("hello", []),
    );
    expect(store.task().status).toBe("running");
    expect(store.queue()).toEqual([]);
    expect(store.request("request-1")?.status).toBe("sending");
    const runningSnapshot = (await (
      await restored.fetch(new Request("https://internal/snapshot"))
    ).json()) as any;
    expect(runningSnapshot.queue).toEqual([]);
    expect(
      runningSnapshot.items.filter((i: any) => i.text === "hello"),
    ).toHaveLength(1);
    fakes.instances[0].finish();
    await vi.waitFor(() => expect(store.task().status).toBe("complete"));
    const another = new DurablePiAgent(ctx, env);
    const snapshot = (await (
      await another.fetch(new Request("https://internal/snapshot"))
    ).json()) as any;
    expect(snapshot.items.map((i: any) => i.text)).toEqual([
      "hello",
      "cloud answer",
    ]);
    expect(snapshot.turns[0].status).toBe("complete");
    expect(snapshot.cursor).toBeGreaterThan(0);
    expect(store.queue()).toEqual([]);
    expect(
      (
        await another.fetch(
          internal("/send", { requestId: "request-1", text: "hello" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await another.fetch(
          internal("/send", { requestId: "request-1", text: "different" }),
        )
      ).status,
    ).toBe(409);
    await another.alarm();
    expect(fakes.createAgent).toHaveBeenCalledTimes(1);
  });

  it("persists queued ordering and stops the active run without deleting queued work", async () => {
    const { agent, store } = fixture();
    await init(agent);
    await agent.fetch(internal("/send", { requestId: "first", text: "first" }));
    await agent.alarm();
    await vi.waitFor(() =>
      expect(fakes.instances[0]?.prompt).toHaveBeenCalled(),
    );
    await agent.fetch(
      internal("/send", { requestId: "second", text: "second" }),
    );
    expect(store.queue().map((q) => q.id)).toEqual(["second"]);
    expect((await agent.fetch(internal("/interrupt", {}))).status).toBe(200);
    expect(store.task().status).toBe("interrupted");
    expect(store.queue().map((q) => q.id)).toEqual(["second"]);
    await agent.alarm();
    expect(fakes.createAgent).toHaveBeenCalledTimes(1);
    await agent.fetch(internal("/queue/resume", {}));
    await agent.alarm();
    await vi.waitFor(() =>
      expect(fakes.instances[1]?.prompt).toHaveBeenCalledWith("second", []),
    );
    fakes.instances[1].finish();
    await vi.waitFor(() => expect(store.task().status).toBe("complete"));
  });

  it("reconciles a crashed active turn without executing its possibly-applied effects again", async () => {
    const { agent, store, ctx, env } = fixture();
    await init(agent);
    await agent.fetch(
      internal("/send", { requestId: "crashed", text: "create an issue" }),
    );
    store.putRequest({ ...store.request("crashed")!, status: "sending" });
    store.set("active", {
      id: "crashed",
      taskId: "task-1",
      startedAt: "then",
      finishedAt: null,
      status: "running",
    });
    await new DurablePiAgent(ctx, env).alarm();
    expect(store.task().status).toBe("interrupted");
    expect(store.timeline().items[0].text).toContain("may have taken effect");
    expect(fakes.createAgent).not.toHaveBeenCalled();
  });

  it("keeps undelivered steering in the durable queue after stop", async () => {
    const { agent, store } = fixture();
    await init(agent);
    await agent.fetch(internal("/send", { requestId: "first", text: "first" }));
    await agent.alarm();
    await vi.waitFor(() =>
      expect(fakes.instances[0]?.prompt).toHaveBeenCalled(),
    );
    await agent.fetch(
      internal("/send", {
        requestId: "steer",
        text: "new instruction",
        mode: "steer",
      }),
    );
    expect(fakes.instances[0].steer).toHaveBeenCalled();
    await agent.fetch(internal("/interrupt", {}));
    expect(store.queue()).toMatchObject([
      { id: "steer", status: "pending", mode: "queue" },
    ]);
  });

  it("replays persisted events and falls back to a full snapshot for expired cursors", async () => {
    const { agent, store, ctx, env } = fixture();
    await init(agent);
    store.transaction(() => {
      for (let i = 0; i < 2010; i++) store.emitQueue();
    });
    const restored = new DurablePiAgent(ctx, env);
    const stale = (await (
      await restored.fetch(new Request("https://internal/events?after=0"))
    ).json()) as any;
    expect(stale.snapshot.cursor).toBe(2010);
    const recent = (await (
      await restored.fetch(new Request("https://internal/events?after=2008"))
    ).json()) as any;
    expect(recent.events.map((e: any) => e.cursor)).toEqual([2009, 2010]);
  });

  it("retries directory publication from persisted task events", async () => {
    const { agent, publish, ctx, env, store } = fixture();
    await init(agent);
    await vi.waitFor(() => expect(store.get("published")).toBe(0));
    publish.mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 }),
    );
    await agent.fetch(internal("/title", { title: "Retained name" }));
    await vi.waitFor(() =>
      expect(publish.mock.calls.length).toBeGreaterThan(1),
    );
    const cursor = store.cursor();
    expect(store.get("published")).toBeLessThan(cursor);
    publish.mockImplementation(async () => Response.json({ ok: true }));
    await new DurablePiAgent(ctx, env).alarm();
    expect(store.get("published")).toBe(cursor);
  });

  it("rechecks optimistic image edits after the attachment claim yields", async () => {
    const { agent, store, publish } = fixture();
    await init(agent);
    await agent.fetch(
      internal("/send", { requestId: "queued", text: "hello" }),
    );
    let release!: (response: Response) => void;
    publish.mockImplementation((request: Request) =>
      new URL(request.url).pathname === "/claim"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(Response.json({ ok: true })),
    );
    const edit = agent.fetch(
      internal("/queue/edit", {
        id: "queued",
        text: "edited",
        expectedText: "hello",
        expectedImages: [],
        images: [],
      }),
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    store.putRequest({
      ...store.request("queued")!,
      images: [
        { id: "new-image", name: "image", mimeType: "image/png", size: 10 },
      ],
    });
    release(Response.json([]));
    expect((await edit).status).toBe(409);
    expect(store.request("queued")!.images![0].id).toBe("new-image");
  });

  it("bounds queue events below SQLite row limits and accepts empty action bodies", async () => {
    const { agent, store } = fixture();
    await init(agent);
    const accepted = [];
    for (let i = 0; i < 14; i++)
      accepted.push(
        (
          await agent.fetch(
            internal("/send", {
              requestId: `large-${i}`,
              text: "x".repeat(100_000),
            }),
          )
        ).status,
      );
    expect(accepted).toContain(429);
    expect(
      new TextEncoder().encode(JSON.stringify(store.queue())).length,
    ).toBeLessThan(1024 * 1024);
    expect(
      (
        await agent.fetch(
          new Request("https://internal/interrupt", {
            method: "POST",
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe("Worker boundary", () => {
  it("serves assets without auth, gates API and rejects foreign origins and the retired run endpoint", async () => {
    const { env } = fixture();
    env.ASSETS = {
      fetch: vi.fn(async () => new Response("UI")),
    } as unknown as Fetcher;
    expect(
      await (await worker.fetch(new Request("https://app.test/"), env)).text(),
    ).toBe("UI");
    expect(
      (await worker.fetch(new Request("https://app.test/api/bootstrap"), env))
        .status,
    ).toBe(401);
    const headers = { authorization: `Bearer ${env.TINYCODE_AGENT_TOKEN}` };
    expect(
      (
        await worker.fetch(
          new Request("https://app.test/api/bootstrap", {
            headers: { ...headers, origin: "https://evil.test" },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request("https://app.test/v1/agents/id/run", { headers }),
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await worker.fetch(
          new Request("https://app.test/api/health", { headers }),
          env,
        )
      ).json(),
    ).toMatchObject({ authority: "cloud", protocol: 2 });
  });
  it("uses a secure browser cookie and supports authenticated WebSocket handshakes", async () => {
    const { env } = fixture();
    const token = env.TINYCODE_AGENT_TOKEN!;
    const response = await worker.fetch(
      new Request("https://app.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; Secure; SameSite=Strict",
    );
    expect(response.headers.get("set-cookie")).not.toContain(token);
    expect(
      await authorized(
        new Request("https://app.test/socket", {
          headers: { cookie: `__Host-tinycode=${await sessionToken(token)}` },
        }),
        token,
      ),
    ).toBe(true);
    expect(
      await authorized(
        new Request("https://app.test/socket", {
          headers: {
            "sec-websocket-protocol": `tinycode, tinycode.auth.${btoa(token).replace(/=+$/, "")}`,
          },
        }),
        token,
      ),
    ).toBe(true);
  });

  it("buffers live events during snapshot subscription and drops those already included", async () => {
    const ctx = context();
    let resolve!: (response: Response) => void;
    const snapshot = new Promise<Response>((r) => {
      resolve = r;
    });
    const env = {
      AGENTS: {
        idFromName: (id: string) => id,
        get: () => ({ fetch: () => snapshot }),
      },
    } as unknown as Env;
    const directory = new TaskDirectory(ctx, env);
    const packets: any[] = [];
    let attachment: any = {};
    const socket = {
      send: (s: string) => packets.push(JSON.parse(s)),
      deserializeAttachment: () => attachment,
      serializeAttachment: (v: any) => {
        attachment = v;
      },
    };
    ctx.sockets.push(socket);
    const task = { id: "task-1", updatedAt: "now" };
    ctx.storage.sql.exec(
      "INSERT INTO tasks VALUES (?,0,?,?)",
      task.id,
      JSON.stringify(task),
      "{}",
    );
    const subscription = directory.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ type: "subscribe", taskId: task.id }),
    );
    await directory.fetch(
      internal("/publish", {
        task,
        cursor: 2,
        events: [
          { cursor: 1, packet: { type: "queue", taskId: task.id, queue: [] } },
          { cursor: 2, packet: { type: "queue", taskId: task.id, queue: [] } },
        ],
      }),
    );
    resolve(
      Response.json({
        type: "timeline",
        taskId: task.id,
        items: [],
        turns: [],
        queue: [],
        approvals: [],
        hasOlder: false,
        cursor: 1,
      }),
    );
    await subscription;
    expect(
      packets.filter((p) => p.type === "cloud.event").map((p) => p.cursor),
    ).toEqual([2]);
    expect(packets.findIndex((p) => p.type === "timeline")).toBeLessThan(
      packets.findIndex((p) => p.type === "cloud.event"),
    );
  });
});
