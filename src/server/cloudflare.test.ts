import { afterEach, describe, expect, test, vi } from "vitest";
import { createCloudflare } from "./adapters/cloudflare.js";
import { pendingProviders, probeProviders } from "./adapters/index.js";
import { cloudflareAgentUrl, cloudflareModels } from "./adapters/cloudflare-client.js";
import type { Sink } from "./adapters/types.js";
import type { Task } from "../shared/contracts.js";

const base = "https://agent.example.workers.dev";

function task(): Task {
  return {
    id: "task_cloudflare_1",
    projectId: null,
    title: "Cloud task",
    provider: "cloudflare",
    model: "openai/gpt-5.4",
    thinkingLevel: "medium",
    permissionMode: "native",
    status: "idle",
    attentionId: null,
    cwd: "/unused",
    worktreePath: null,
    nativeSessionId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

function sink(): Sink {
  return {
    add: vi.fn((kind) => `${kind}-row`),
    delta: vi.fn(),
    patch: vi.fn(),
    identity: vi.fn(),
    model: vi.fn(),
    status: vi.fn(),
    ask: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Cloudflare agent adapter", () => {
  test("authenticates the task-scoped NDJSON run and projects its events", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    const stream = [
      { type: "session", sessionId: "do-id", model: "openai/gpt-5.4" },
      { type: "content.start", id: "answer", kind: "assistant" },
      { type: "content.delta", id: "answer", text: "hel" },
      { type: "content.end", id: "answer", text: "hello" },
      { type: "tool.start", id: "tool:1", name: "vm_exec", input: { command: "pwd" } },
      { type: "tool.end", id: "tool:1", output: "/workspace", isError: false },
      { type: "done" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const fetch = vi.fn(async () => new Response(`${stream}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const output = sink();
    const session = await createCloudflare({
      task: task(),
      sink: output,
      command: base,
      dataDir: "/unused",
    });

    await session.run("Say hello", []);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${base}/v1/agents/task_cloudflare_1/run`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer transport-secret");
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: "Say hello",
      model: "openai/gpt-5.4",
      thinkingLevel: "medium",
    });
    expect(output.identity).toHaveBeenCalledWith("do-id");
    expect(output.model).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(output.delta).toHaveBeenCalledWith("assistant-row", "hel");
    expect(output.patch).toHaveBeenCalledWith("assistant-row", {
      text: "hello",
      status: "complete",
    });
    expect(output.patch).toHaveBeenCalledWith("tool-row", {
      text: "/workspace",
      status: "complete",
    });
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
        return Response.json({ ok: true, ready: true, version: "0.1.0", protocol: 1 });
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

  test("surfaces a Worker JSON error without leaking transport details", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "This agent is already running" }, { status: 409 })),
    );
    const session = await createCloudflare({
      task: task(),
      sink: sink(),
      command: base,
      dataDir: "/unused",
    });
    const error = await session.run("again", []).catch((caught) => caught as Error);
    if (!(error instanceof Error)) throw new Error("Expected the Cloudflare run to fail");
    expect(error.message).toContain("This agent is already running");
    expect(error.message).not.toContain("transport-secret");
    expect(error.message).not.toContain(base);
  });

  test("rejects Pi provider failures and waits for the remote interrupt", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    let stopped = false;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/run"))
        return new Response(
          `${JSON.stringify({ type: "session", sessionId: "do-id", model: "openai/gpt-5.4" })}\n${JSON.stringify({ type: "content.start", id: "answer", kind: "assistant" })}\n${JSON.stringify({ type: "error", message: "provider failed" })}\n`,
          { status: 200 },
        );
      if (url.endsWith("/interrupt")) {
        await stopGate;
        stopped = true;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const output = sink();
    const session = await createCloudflare({
      task: task(),
      sink: output,
      command: base,
      dataDir: "/unused",
    });

    let settled = false;
    const run = session.run("fail", []).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    releaseStop();
    await expect(run).rejects.toThrow("provider failed");
    expect(stopped).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(output.patch).toHaveBeenCalledWith("assistant-row", { status: "failed" });
  });

  test("cancels a partially consumed event stream after a protocol error", async () => {
    vi.stubEnv("TINYCODE_CLOUDFLARE_AGENT_TOKEN", "transport-secret");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ type: "error", message: "bad event" })}\n`),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/interrupt")
          ? Response.json({ ok: true })
          : new Response(body, { status: 200 }),
      ),
    );
    const session = await createCloudflare({
      task: task(),
      sink: sink(),
      command: base,
      dataDir: "/unused",
    });

    await expect(session.run("fail", [])).rejects.toThrow("bad event");
    expect(cancelled).toBe(true);
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
      expect.objectContaining({ id: "cloudflare", command: "", readiness: "error" }),
    );
  });
});
