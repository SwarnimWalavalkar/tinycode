import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { Env } from "./env.js";
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
  ContainerProxy: class {},
  getSandbox: vi.fn(),
}));
import {
  Accounts,
  ACCOUNT_SESSION_MS,
  SESSION_COOKIE,
  OAUTH_COOKIE,
} from "./accounts.js";
import worker from "./index.js";
import { TaskDirectory } from "./directory.js";

function context() {
  const db = new Database(":memory:");
  const sockets: any[] = [];
  const storage = {
    sql: {
      exec(query: string, ...args: any[]) {
        if (!args.length && query.includes(";")) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const stmt = db.prepare(query);
        const rows = stmt.reader ? stmt.all(...args) : (stmt.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
  };
  return {
    storage,
    getWebSockets: () => sockets,
    sockets,
    blockConcurrencyWhile: async (fn: () => any) => fn(),
  } as unknown as DurableObjectState & { sockets: any[] };
}
function fixture() {
  const env = {
    GITHUB_OAUTH_CLIENT_ID: "client",
    GITHUB_OAUTH_CLIENT_SECRET: "secret",
    TINYCODE_AUTH_SECRET: "x".repeat(40),
  } as Env;
  const ctx = context();
  const accounts = new Accounts(ctx, env);
  env.ACCOUNTS = { idFromName: (s: string) => s, get: () => accounts } as any;
  const directories = new Map<string, TaskDirectory>();
  const contexts = new Map<string, ReturnType<typeof context>>();
  env.DIRECTORY = {
    idFromName: (s: string) => s,
    get: (s: string) => {
      if (!directories.has(s)) {
        const c = context();
        contexts.set(s, c);
        directories.set(s, new TaskDirectory(c, env));
      }
      return directories.get(s)!;
    },
  } as any;
  const agentFetch = vi.fn(async (request: Request) =>
    new URL(request.url).pathname === "/init"
      ? Response.json({
          ...((await request.json()) as any),
          updatedAt: "now",
          provider: "cloudflare",
        })
      : Response.json({ ok: true }),
  );
  const agentNames: string[] = [];
  env.AGENTS = {
    idFromName: (s: string) => {
      agentNames.push(s);
      return s;
    },
    get: () => ({ fetch: agentFetch }),
  } as any;
  const objects = new Map<string, { data: Uint8Array; customMetadata: any }>();
  env.ATTACHMENTS = {
    head: async (key: string) => objects.get(key) ?? null,
    put: async (key: string, data: Uint8Array, options: any) =>
      objects.set(key, { data, customMetadata: options.customMetadata }),
    get: async (key: string) =>
      objects.has(key) ? { body: objects.get(key)!.data } : null,
    delete: async (keys: string | string[]) => {
      for (const key of [keys].flat()) objects.delete(key);
    },
  } as any;
  return {
    env,
    accounts,
    ctx,
    contexts,
    directories,
    agentNames,
    agentFetch,
    objects,
  };
}
function provider(id = 1, extra: Record<string, unknown> = {}) {
  return vi.fn(async (request: string | Request) => {
    const url = typeof request === "string" ? request : request.url;
    if (url.includes("/login/oauth/access_token"))
      return Response.json({
        access_token: `token-${id}`,
        token_type: "bearer",
        scope: "repo,workflow",
        ...extra,
      });
    return Response.json({ id, login: `user${id}`, name: `User ${id}` });
  });
}
async function signIn(
  accounts: Accounts,
  id = 1,
  extra: Record<string, unknown> = {},
) {
  vi.stubGlobal("fetch", provider(id, extra));
  const { state } = await accounts.begin(
    "https://app.test/api/auth/github/callback",
  );
  return accounts.complete(
    state,
    "code",
    "https://app.test/api/auth/github/callback",
  );
}
function request(
  path: string,
  token?: string,
  method = "GET",
  value?: unknown,
  extra: Record<string, string> = {},
) {
  return new Request(`https://app.test${path}`, {
    method,
    headers: {
      origin: "https://app.test",
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      "content-type": "application/json",
      ...extra,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub accounts", () => {
  it("uses PKCE, consumes state once, encrypts credentials, and expires/revokes sessions", async () => {
    const { accounts, ctx } = fixture();
    const mock = provider();
    vi.stubGlobal("fetch", mock);
    const start = await accounts.begin("https://app.test/callback");
    const params = new URL(start.url).searchParams;
    expect(params.get("scope")).toBe("repo workflow offline_access");
    expect(params.get("code_challenge")).toHaveLength(43);
    const signed = await accounts.complete(
      start.state,
      "code",
      "https://app.test/callback",
    );
    expect(await accounts.session(signed.token)).toMatchObject({
      user: { id: "github-1" },
    });
    const saved = ctx.storage.sql
      .exec<{ credential: string }>("SELECT credential FROM users")
      .toArray()[0].credential;
    expect(saved).not.toContain("token-1");
    await expect(
      accounts.complete(start.state, "code", "https://app.test/callback"),
    ).rejects.toThrow("expired");
    expect(await accounts.session("forged")).toBeNull();
    await accounts.logout(signed.token);
    expect(await accounts.session(signed.token)).toBeNull();
    const next = await signIn(accounts);
    vi.spyOn(Date, "now").mockReturnValueOnce(
      Date.now() + ACCOUNT_SESSION_MS + 1,
    );
    expect(await accounts.session(next.token)).toBeNull();
  });
  it("rejects expired OAuth state and callback mismatch before exchanging the code", async () => {
    const { accounts, ctx } = fixture();
    const mock = provider();
    vi.stubGlobal("fetch", mock);
    const a = await accounts.begin("https://app.test/callback");
    await expect(
      accounts.complete(a.state, "code", "https://evil.test/callback"),
    ).rejects.toThrow("expired");
    const b = await accounts.begin("https://app.test/callback");
    ctx.storage.sql.exec("UPDATE oauth SET expires=0");
    await expect(
      accounts.complete(b.state, "code", "https://app.test/callback"),
    ).rejects.toThrow("expired");
    expect(mock).not.toHaveBeenCalled();
  });
  it("injects each user's token for Git and API requests and blocks token-management endpoints", async () => {
    const { accounts } = fixture();
    await signIn(accounts, 1);
    await signIn(accounts, 2);
    const upstream = vi.fn(
      async (_request: Request) =>
        new Response("ok", { headers: { "set-cookie": "secret" } }),
    );
    vi.stubGlobal("fetch", upstream);
    const result = await accounts.github(
      "github-1",
      new Request("https://github.com/org/private.git/git-receive-pack", {
        method: "POST",
        body: "pack",
      }),
    );
    const git = upstream.mock.calls[0][0] as unknown as Request;
    expect(git.headers.get("authorization")).toBe(
      `Basic ${btoa("x-access-token:token-1")}`,
    );
    expect(result.headers.get("set-cookie")).toBeNull();
    await accounts.github(
      "github-2",
      new Request("https://api.github.com/repos/org/private/pulls", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(
      (upstream.mock.calls[1][0] as unknown as Request).headers.get(
        "authorization",
      ),
    ).toBe("Bearer token-2");
    expect(
      (
        await accounts.github(
          "github-1",
          new Request("https://api.github.com/applications/client/token"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await accounts.github(
          "github-1",
          new Request("https://evil.test/repos/org/private"),
        )
      ).status,
    ).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(2);
    await accounts.disconnect("github-1");
    expect(
      (
        await accounts.github(
          "github-1",
          new Request("https://api.github.com/user"),
        )
      ).status,
    ).toBe(401);
    expect((await accounts.profile("github-1")).connected).toBe(false);
  });
  it("refreshes expiring tokens once for concurrent requests, while retaining long-lived grants", async () => {
    const { accounts } = fixture();
    await signIn(accounts, 1, {
      expires_in: 1,
      refresh_token: "refresh",
      refresh_token_expires_in: 1000,
    });
    let exchanges = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: string | Request) => {
        if (typeof value === "string") {
          exchanges++;
          return Response.json({
            access_token: "renewed",
            token_type: "bearer",
            scope: "repo,workflow",
            expires_in: 3600,
            refresh_token: "next-refresh",
            refresh_token_expires_in: 10000,
          });
        }
        expect(value.headers.get("authorization")).toBe("Bearer renewed");
        return Response.json({ ok: true });
      }),
    );
    await Promise.all(
      [1, 2, 3].map(() =>
        accounts.github("github-1", new Request("https://api.github.com/user")),
      ),
    );
    expect(exchanges).toBe(1);
    await accounts.github(
      "github-1",
      new Request("https://api.github.com/user"),
    );
    expect(exchanges).toBe(1);
  });
  it("clears terminal refresh failures but retains grants on provider outages", async () => {
    for (const [error, status, connected] of [["invalid_grant", 400, false], ["server_error", 503, true]] as const) {
      const { accounts } = fixture();
      await signIn(accounts, 1, { expires_in: 1, refresh_token: "refresh", refresh_token_expires_in: 1000 });
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error }, { status })));
      await accounts.github("github-1", new Request("https://api.github.com/user"));
      expect((await accounts.profile("github-1")).connected).toBe(connected);
    }
  });
  it("disconnect prevents an in-flight refresh from restoring a grant", async () => {
    const { accounts } = fixture();
    await signIn(accounts, 1, { expires_in: 1, refresh_token: "refresh", refresh_token_expires_in: 1000 });
    let release!: (value: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }));
    const pending = accounts.github("github-1", new Request("https://api.github.com/user"));
    await ready;
    await accounts.disconnect("github-1");
    release(Response.json({ access_token: "renewed", token_type: "bearer", scope: "repo,workflow", expires_in: 3600 }));
    expect((await pending).status).toBe(401);
    expect((await accounts.profile("github-1")).connected).toBe(false);
  });
  it("marks revoked credentials disconnected without retrying a write", async () => {
    const { accounts } = fixture();
    await signIn(accounts);
    const upstream = vi.fn(
      async () => new Response("revoked", { status: 401 }),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      (
        await accounts.github(
          "github-1",
          new Request("https://api.github.com/repos/org/repo/pulls", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await accounts.profile("github-1")).connected).toBe(false);
  });
});

describe("account isolation through the Worker and directory", () => {
  it("binds OAuth to the browser and never accepts the legacy token in GitHub mode", async () => {
    const { env } = fixture();
    env.TINYCODE_AGENT_TOKEN = "legacy-token";
    const start = await worker.fetch(request("/api/auth/github"), env);
    expect(start.status).toBe(303);
    expect(start.headers.get("set-cookie")).toContain(`${OAUTH_COOKIE}=`);
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    expect(
      (
        await worker.fetch(
          request(`/api/auth/github/callback?state=${state}&code=code`),
          env,
        )
      ).headers.get("location"),
    ).toContain("login_error");
    expect(
      (
        await worker.fetch(
          request("/api/bootstrap", undefined, "GET", undefined, {
            authorization: "Bearer legacy-token",
            "x-tinycode-owner": "github-1",
          }),
          env,
        )
      ).status,
    ).toBe(401);
    vi.stubGlobal("fetch", provider());
    const good = await worker.fetch(
      request(
        `/api/auth/github/callback?state=${state}&code=code`,
        undefined,
        "GET",
        undefined,
        { cookie: `${OAUTH_COOKIE}=${state}` },
      ),
      env,
    );
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toBe("/");
    expect(good.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(good.headers.get("set-cookie")).not.toContain("token-1");
  });
  it("isolates task IDs, rejects forged owners and internal init, and checks websocket subscriptions", async () => {
    const { env, accounts, agentNames, contexts, directories, agentFetch } =
      fixture();
    const a = await signIn(accounts, 1),
      b = await signIn(accounts, 2);
    const create = {
      provider: "cloudflare",
      requestId: "same-id",
      owner: "github-2",
    };
    const first = await worker.fetch(request("/api/tasks", a.token, "POST", {
      ...create, workspaceId: "personal-github-2", createdBy: "github-2", githubAccountId: "github-2",
    }, { "x-tinycode-owner": "github-2" }), env);
    expect(first.status).toBe(200);
    const taskA = await first.json() as any;
    expect(taskA).toMatchObject({workspaceId: "personal-github-1", createdBy: "github-1", githubAccountId: "github-1"});
    expect(taskA.id).not.toBe("same-id");
    expect(agentNames).toContain(`task:${taskA.id}`);
    expect((await worker.fetch(request(`/api/tasks/${taskA.id}`, b.token), env)).status).toBe(404);
    expect((await worker.fetch(request(`/api/tasks/${taskA.id}/init`, a.token, "POST", {}), env)).status).toBe(404);
    const retry = await worker.fetch(request("/api/tasks", a.token, "POST", create), env);
    expect((await retry.json() as any).id).toBe(taskA.id);
    const second = await worker.fetch(request("/api/tasks", b.token, "POST", create), env);
    expect(second.status).toBe(200);
    const taskB = await second.json() as any;
    expect(taskB.id).not.toBe(taskA.id);
    expect(agentNames).toContain(`task:${taskB.id}`);
    expect(
      (
        await worker.fetch(
          request("/api/tasks", a.token, "POST", create, {
            origin: "https://evil.test",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const packets: any[] = [];
    let attachment: any = {
      generation: "x",
      syncing: false,
      expiresAt: Date.now() + 60000,
    };
    const socket = {
      send: (p: string) => packets.push(JSON.parse(p)),
      deserializeAttachment: () => attachment,
      serializeAttachment: (v: any) => {
        attachment = v;
      },
      close: vi.fn(),
    };
    contexts.get("personal-github-2")!.sockets.push(socket);
    const before = agentFetch.mock.calls.length;
    await directories
      .get("personal-github-2")!
      .webSocketMessage(
        socket as any,
        JSON.stringify({ type: "subscribe", taskId: taskA.id }),
      );
    expect(packets.at(-1)).toMatchObject({
      type: "error",
      message: "Task not found",
    });
    expect(agentFetch.mock.calls).toHaveLength(before);
    expect(
      (await worker.fetch(request("/api/logout", b.token, "POST"), env)).status,
    ).toBe(200);
    expect(socket.close).toHaveBeenCalled();
    expect(
      (await worker.fetch(request("/api/bootstrap", b.token), env)).status,
    ).toBe(401);
  });
  it("isolates attachment storage even when two users choose the same ID", async () => {
    const { env, accounts, objects } = fixture();
    const a = await signIn(accounts, 1),
      b = await signIn(accounts, 2);
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = (token: string) =>
      new Request("https://app.test/api/images/same-image", {
        method: "PUT",
        headers: {
          origin: "https://app.test",
          cookie: `${SESSION_COOKIE}=${token}`,
          "content-type": "image/png",
        },
        body: png,
      });
    expect((await worker.fetch(upload(a.token), env)).status).toBe(200);
    expect(
      (await worker.fetch(request("/api/images/same-image", b.token), env))
        .status,
    ).toBe(404);
    expect((await worker.fetch(upload(b.token), env)).status).toBe(200);
    expect([...objects.keys()]).toEqual([
      "workspaces/personal-github-1/images/same-image",
      "workspaces/personal-github-2/images/same-image",
    ]);
    await worker.fetch(
      request("/api/images/same-image", a.token, "DELETE"),
      env,
    );
    expect(
      (await worker.fetch(request("/api/images/same-image", b.token), env))
        .status,
    ).toBe(200);
  });
});
