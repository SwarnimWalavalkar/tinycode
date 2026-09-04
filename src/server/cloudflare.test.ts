import { afterEach, describe, expect, test, vi } from "vitest";
import { createCloudflare } from "./adapters/cloudflare.js";
import { probeProviders } from "./adapters/index.js";
import { cloudflareModels } from "./adapters/cloudflare-client.js";
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
    await expect(session.run("again", [])).rejects.toThrow("This agent is already running");
  });
});
