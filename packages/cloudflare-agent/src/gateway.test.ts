import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import type { Env } from "./env.js";
import { completionError, createPiAgent, modelCatalog, normalizeThinkingLevel, resolveModel } from "./models.js";
import { gatewayCredential } from "./gateway.js";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
  CLOUDFLARE_GATEWAY_ID: "tinycode",
} as Env;
const workersModel = "@cf/openai/gpt-oss-120b";
const custom = (): Env => ({
  ...env,
  TINYCODE_DEFAULT_MODEL: workersModel,
  TINYCODE_MODELS: workersModel,
});
const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare model boundary", () => {
  it("does not report thought-only or truncated turns as complete", () => {
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Use a tool" }] };
    expect(completionError([message] as any)).toContain("no final answer");
    expect(completionError([{ ...message, stopReason: "length" }] as any)).toContain("output limit");
  });
  it("preserves existing model IDs but routes only through the Cloudflare account API", () => {
    const { model } = resolveModel(env, "openai/gpt-5.4");
    expect(model.id).toBe("openai/gpt-5.4");
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    );
    expect(model.headers).toEqual({
      "cf-aig-gateway-id": "tinycode",
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log-payload": "false",
    });
    expect(modelCatalog(env).models[0].description).toContain("AI Gateway");
  });

  it("validates configuration and never falls back to an OpenAI key", () => {
    expect(() =>
      gatewayCredential({
        ...env,
        CLOUDFLARE_API_TOKEN: undefined,
        OPENAI_API_KEY: "do-not-use",
      } as Env),
    ).toThrow("CLOUDFLARE_API_TOKEN");
    expect(() => gatewayCredential({ ...env, CLOUDFLARE_ACCOUNT_ID: "../other" })).toThrow(
      "CLOUDFLARE_ACCOUNT_ID",
    );
    expect(() => gatewayCredential({ ...env, CLOUDFLARE_GATEWAY_ID: "bad\r\nheader" })).toThrow(
      "GATEWAY_ID",
    );
    expect(() => resolveModel(env, "anthropic/unconfigured")).toThrow("not enabled");
  });

  it("uses declared model capabilities for Workers AI and external models", () => {
    expect(modelCatalog(custom()).models[0]).toMatchObject({
      thinkingLevels: [],
      defaultThinkingLevel: null,
      description: expect.stringContaining("Workers AI"),
    });
    expect(normalizeThinkingLevel(custom(), workersModel, null)).toBe("off");
    expect(() => normalizeThinkingLevel(env, "openai/gpt-5.4", "unsupported")).toThrow(
      "not supported",
    );
  });

  it("streams a complete tool roundtrip with the shipped GPT OSS preset", async () => {
    const deployment = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ).vars;
    const modelId = workersModel;
    const config = { ...deployment, ...env };
    const requests: { url: string; headers: Headers; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          id: "chat_test", created: 1, model: workersModel,
          choices: [{ index: 0, finish_reason: requests.length === 1 ? "tool_calls" : "stop",
            message: requests.length === 1
              ? { role: "assistant", content: null, tool_calls: [{ type: "function", id: "call_1", function: { name: "check", arguments: '{"value":"ok"}' } }] }
              : { role: "assistant", content: "Done", reasoning_content: "The tool succeeded" },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }),
    );
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "tool worked" }],
      details: {},
    }));
    const agent = createPiAgent(config, {
      sessionId: "test",
      modelId,
      systemPrompt: "Test",
      tools: [
        {
          name: "check",
          label: "Check",
          description: "Test",
          parameters: Type.Object({ value: Type.String() }),
          execute,
        },
      ],
    });
    await agent.prompt("Check", []);
    expect(agent.state.errorMessage).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
      );
      expect(request.headers.get("authorization")).toBe("Bearer test-cloudflare-token");
      expect(request.headers.get("cf-aig-gateway-id")).toBe("tinycode");
      expect(request.body.model).toBe(modelId);
      expect(request.body.reasoning_effort).toBeUndefined();
      expect(request.body.stream).toBe(false);
    }
    expect(requests[0].body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "check" },
    });
    expect(requests[1].body.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
        content: "tool worked",
      }),
    );
    expect(completionError(agent.state.messages)).toBeUndefined();
    const final = agent.state.messages.at(-1);
    expect(final?.role === "assistant" && final.content.map(part => part.type)).toEqual(["thinking", "text"]);
  });

  it("uses Responses with qualified model IDs and reasoning, retaining streamed text", async () => {
    let payload: any;
    let endpoint = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        endpoint = String(url);
        payload = JSON.parse(String(init?.body));
        const item = {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        };
        return sse([
          { type: "response.created", response: { id: "resp_test" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            delta: "Hello",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_test",
              status: "completed",
              output: [item],
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            },
          },
        ]);
      }),
    );
    const agent = createPiAgent(env, {
      sessionId: "test",
      modelId: "openai/gpt-5.4",
      thinkingLevel: "medium",
      systemPrompt: "Test",
    });
    await agent.prompt("hello");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(endpoint).toContain("api.cloudflare.com/");
    expect(endpoint).toMatch(/\/ai\/v1\/responses$/);
    expect(payload.model).toBe("openai/gpt-5.4");
    expect(payload.reasoning.effort).toBe("medium");
    expect(payload.store).toBe(false);
    const answer = agent.state.messages.at(-1);
    expect(answer && "content" in answer ? answer.content : undefined).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello" }),
    );
  });

  it("rejects images for text-only models without sending them or dropping them silently", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const agent = createPiAgent(custom(), {
      sessionId: "test",
      modelId: workersModel,
      systemPrompt: "Test",
    });
    await agent.prompt("Describe", [{ type: "image", mimeType: "image/png", data: "AA==" }]);
    expect(agent.state.errorMessage).toContain("does not support image");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight gateway request when the agent is interrupted", async () => {
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const agent = createPiAgent(env, {
      sessionId: "test",
      modelId: "openai/gpt-5.4",
      systemPrompt: "Test",
    });
    const run = agent.prompt("wait");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    agent.abort();
    await run;
    const answer = agent.state.messages.at(-1);
    expect(answer?.role === "assistant" && answer.stopReason).toBe("aborted");
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("surfaces gateway authentication failures without retrying directly against a provider", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: "Gateway access denied" } }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetch);
    const agent = createPiAgent(env, {
      sessionId: "test",
      modelId: "openai/gpt-5.4",
      systemPrompt: "Test",
    });
    await agent.prompt("hello");
    expect(agent.state.errorMessage).toContain("Gateway access denied");
    expect(agent.state.errorMessage).not.toContain(env.CLOUDFLARE_API_TOKEN);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
