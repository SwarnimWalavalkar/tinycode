import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createPiAgent, completionError, modelCatalog } from "./models.js";
import { GO_DEFAULT, GO_BASE_URL } from "./opencode-go.js";
import type { Env } from "./env.js";

afterEach(() => vi.unstubAllGlobals());
describe("OpenCode Go inference", () => {
  it("streams tool calls with the user's current key and a stable session, without gateway credentials", async () => {
    const calls: { url: string; headers: Headers; body: any }[] = [];
    let key = "user-one-key";
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const first = calls.length === 1;
      const chunk = { id: "completion", model: "glm-5.3-flash", object: "chat.completion.chunk", created: 1,
        choices: [{ index: 0, delta: first
          ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "check", arguments: "{}" } }] }
          : { role: "assistant", content: "Done" }, finish_reason: first ? "tool_calls" : "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    const agent = createPiAgent({} as Env, {
      sessionId: "stable-task", modelId: GO_DEFAULT, systemPrompt: "Use check", getGoKey: async () => key,
      tools: [{ name: "check", label: "Check", description: "Check", parameters: Type.Object({}),
        execute: async () => { key = "replacement-key"; return { content: [{ type: "text", text: "ok" }], details: {} }; } }],
    });
    await agent.prompt("Check");
    expect(completionError(agent.state.messages)).toBeUndefined();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(`${GO_BASE_URL}/chat/completions`);
      expect(call.body.model).toBe("glm-5.3-flash");
      expect(call.headers.get("x-opencode-session")).toBe("stable-task");
      expect(call.headers.get("user-agent")).toBe("tinycode/0.1");
      expect(call.headers.has("cf-aig-gateway-id")).toBe(false);
    }
    expect(calls[0].headers.get("authorization")).toBe("Bearer user-one-key");
    expect(calls[1].headers.get("authorization")).toBe("Bearer replacement-key");
    expect(calls[1].body.messages.some((m: any) => m.role === "tool")).toBe(true);
  });
  it.each([401, 402, 429, 500])("surfaces actionable errors for %s without retrying or exposing upstream data", async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: "secret-key-and-prompt" } }, { status }));
    vi.stubGlobal("fetch", fetch);
    const agent = createPiAgent({} as Env, { sessionId: "s", modelId: GO_DEFAULT, systemPrompt: "Hi", getGoKey: async () => "key" });
    await agent.prompt("Hi");
    expect(agent.state.errorMessage).toContain("OpenCode Go");
    expect(agent.state.errorMessage).not.toContain("secret-key-and-prompt");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not infer after disconnect and exposes Go models only for connected users", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const agent = createPiAgent({} as Env, { sessionId: "s", modelId: GO_DEFAULT, systemPrompt: "Hi", getGoKey: async () => { throw new Error("Connect OpenCode Go in the model picker to continue"); } });
    await agent.prompt("Hi");
    expect(agent.state.errorMessage).toContain("Connect OpenCode Go");
    expect(fetch).not.toHaveBeenCalled();
    expect(modelCatalog({} as Env).models.some(m => m.id === GO_DEFAULT)).toBe(false);
    expect(modelCatalog({} as Env, true).defaultModel).toBe(GO_DEFAULT);
  });
});
