import { afterEach, describe, expect, test, vi } from "vitest";
import { pendingProviders, probeProviders } from "./adapters/index.js";
import { cloudflareAgentUrl, cloudflareModels } from "./adapters/cloudflare-client.js";
import { CloudAuthority } from "./cloud-authority.js";
import { Store } from "./db.js";
import { Images } from "./images.js";
import type { Task } from "../shared/contracts.js";
const base = "https://agent.example.workers.dev";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("Cloudflare authority bridge", () => {
  test("imports every legacy timeline page and receipt without mutating local originals", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_URL", base);
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    const store = new Store(":memory:");
    const task: Task = {
      id: "legacy-task",
      projectId: null,
      provider: "cloudflare",
      title: "Legacy",
      status: "complete",
      model: "openai/gpt-5.4",
      thinkingLevel: "medium",
      permissionMode: "native",
      attentionId: null,
      cwd: "/unused",
      worktreePath: null,
      nativeSessionId: "retained-do",
      createdAt: "then",
      updatedAt: "then",
    };
    store.insertTask(task);
    for (let i = 0; i < 125; i++)
      store.append({ id: `item-${i}`, taskId: task.id, kind: "user", text: `message ${i}` });
    for (let i = 0; i < 501; i++) store.claimRequest(`request-${i}`, task.id);
    store.enqueue({
      id: "pending",
      taskId: task.id,
      text: "later",
      mode: "queue",
      status: "pending",
      error: null,
      createdAt: "then",
    });
    const inputs: any[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      inputs.push(input);
      return Response.json(url.endsWith("/api/tasks") ? task : { ok: true });
    });
    vi.stubGlobal("fetch", fetch);
    const cloud = new CloudAuthority(vi.fn());
    try {
      await cloud.migrate(store, new Images(store, "/unused"));
      const calls = fetch.mock.calls.length;
      await cloud.migrate(store, new Images(store, "/unused"));
      expect(fetch.mock.calls).toHaveLength(calls);
      expect(inputs[0]).toMatchObject({ requestId: task.id, legacy: true });
      expect(inputs.flatMap((input) => input.items ?? [])).toHaveLength(125);
      expect(inputs.flatMap((input) => input.receipts ?? [])).toHaveLength(501);
      expect(inputs.at(-1)).toMatchObject({
        finish: true,
        task: { title: "Legacy" },
        queue: [{ id: "pending" }],
      });
      expect(store.queue(task.id)).toHaveLength(1);
      expect(store.requestIds(task.id)).toHaveLength(500);
      expect(store.timeline(task.id).hasOlder).toBe(true);
    } finally {
      cloud.dispose();
      store.db.close();
    }
  });
  test("creates and sends through the cloud API without owning a local run", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_URL", base);
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    const task = {
      id: "cloud-task",
      provider: "cloudflare",
      updatedAt: "2026-09-07",
    };
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      Response.json(url.endsWith("/send") ? { ok: true, runId: "request" } : task),
    );
    vi.stubGlobal("fetch", fetch);
    const cloud = new CloudAuthority(vi.fn());
    expect(await cloud.create({ requestId: task.id, provider: "cloudflare" })).toEqual(task);
    expect(cloud.owns(task.id)).toBe(true);
    expect(cloud.merge([])).toEqual([task]);
    const accepted = await cloud.fetch("/api/tasks/cloud-task/send", {
      method: "POST",
      body: JSON.stringify({ requestId: "request", text: "hello" }),
    });
    expect(await accepted.json()).toEqual({ ok: true, runId: "request" });
    cloud.dispose();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      base + "/api/tasks",
      base + "/api/tasks/cloud-task/send",
    ]);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe(
      "Bearer transport-secret",
    );
  });
  test("reports readiness and models from the deployed Worker", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_URL", `${base}/`);
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    vi.stubEnv("TINYCODE_CODEX_BIN", "/missing/codex");
    vi.stubEnv("TINYCODE_CLAUDE_BIN", "/missing/claude");
    vi.stubEnv("TINYCODE_PI_BIN", "/missing/pi");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/health"))
        return Response.json({
          ok: true,
          ready: true,
          version: "0.1.0",
          protocol: 2,
        });
      if (url.endsWith("/v1/models"))
        return Response.json({
          models: [
            {
              id: "openai/gpt-5.4",
              label: "GPT-5.4",
              description: "Pi SDK · OpenAI · Durable Object",
              thinkingLevels: ["medium"],
              defaultThinkingLevel: "medium",
            },
          ],
          defaultModel: "openai/gpt-5.4",
        });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);

    const providers = await probeProviders("/unused");
    const cloudflare = providers.find((provider) => provider.id === "cloudflare");
    expect(cloudflare).toMatchObject({
      available: true,
      readiness: "ready",
      command: base,
      version: "0.1.0",
    });
    await expect(cloudflareModels(base)).resolves.toMatchObject({
      defaultModel: "openai/gpt-5.4",
    });
  });

  test("never sends the transport token to a plaintext endpoint", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_URL", "http://agent.example.test");
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(() => cloudflareAgentUrl()).toThrow("HTTPS origin");
    await expect(cloudflareModels("http://agent.example.test")).rejects.toThrow("HTTPS origin");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("never publishes an invalid configured Worker URL to browser clients", async () => {
    vi.stubEnv(
      "TINYCODE_CLOUDFLARE_AGENT_URL",
      "https://username:password@agent.example.test/?access_token=secret",
    );

    expect(pendingProviders().find((provider) => provider.id === "cloudflare")?.command).toBe("");
    await expect(probeProviders("/unused")).resolves.toContainEqual(
      expect.objectContaining({
        id: "cloudflare",
        command: "",
        readiness: "error",
      }),
    );
  });
});
