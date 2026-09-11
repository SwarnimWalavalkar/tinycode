import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createPiAgent, completionError, modelCatalog } from "./models.js";
import { GO_DEFAULT, GO_BASE_URL, GO_MODELS, goFetch } from "./opencode-go.js";
import type { Env } from "./env.js";

afterEach(() => vi.unstubAllGlobals());
describe("OpenCode Go inference", () => {
  it("uses Workers-compatible manual redirects without forwarding credentials", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://other.test" } }));
    vi.stubGlobal("fetch", fetch);
    const response = await goFetch(`${GO_BASE_URL}/chat/completions`, { headers: { authorization: "Bearer test" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([`${GO_BASE_URL}/chat/completions`, { headers: { authorization: "Bearer test" }, redirect: "manual" }]);
    expect(response.status).toBe(502);
    expect(response.headers.has("location")).toBe(false);
  });
  it.each(GO_MODELS)("routes $id through its supported protocol", async (definition) => {
    const calls: { url: string; headers: Headers; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return Response.json({ error: { message: "private upstream detail" } }, { status: 401 });
    }));
    const agent = createPiAgent({} as Env, { sessionId: "catalog-test", modelId: definition.id, systemPrompt: "Help with code", getGoKey: async () => "go-test-key" });
    await agent.prompt("Hello");
    expect(calls).toHaveLength(1);
    // Independent upstream endpoint contract: opencode.ai/docs/go/#endpoints.
    // Legacy Qwen3.5 inherits the OpenAI-compatible default in models.dev.
    const messages = ["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus"];
    const responses = ["gpt-5.6-luna", "grok-4.5", "grok-4.6", "muse-spark-1.3-contributor", "muse-spark-1.2-contributor"];
    const id = definition.id.slice("opencode-go/".length);
    const endpoint = messages.includes(id) ? "messages" : responses.includes(id) ? "responses" : "chat/completions";
    expect(calls[0].url).toBe(`${GO_BASE_URL}/${endpoint}`);
    expect(calls[0].body.model).toBe(definition.id.slice("opencode-go/".length));
    expect(calls[0].headers.get("x-opencode-session")).toBe("catalog-test");
    expect(calls[0].headers.get("user-agent")).toBe("tinycode/0.1");
    expect(calls[0].headers.get(definition.api === "anthropic-messages" ? "x-api-key" : "authorization")).toBe(definition.api === "anthropic-messages" ? "go-test-key" : "Bearer go-test-key");
    expect(agent.state.errorMessage).toContain("OpenCode Go");
    expect(agent.state.errorMessage).not.toContain("private upstream detail");
    expect(modelCatalog({} as Env, true).models.some((m) => m.id === definition.id)).toBe(true);
  });
  it.each(["minimax-m3", "gpt-5.6-luna"])("completes a tool round trip using %s", async (id) => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const first = bodies.length === 1;
      let events: any[];
      if (id === "minimax-m3") {
        events = [
          { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: id, content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: first ? { type: "tool_use", id: "call_1", name: "check", input: {} } : { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: first ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: "Done" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ];
      } else {
        const item = first ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "check", arguments: "{}", status: "completed" }
          : { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] };
        events = [
          { type: "response.created", response: { id: "resp_1" } },
          { type: "response.output_item.added", output_index: 0, item: first ? { ...item, arguments: "" } : { ...item, content: [] } },
          first ? { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" } : { type: "response.output_text.delta", output_index: 0, delta: "Done" },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
        ];
      }
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "tool worked" }], details: {} }));
    const agent = createPiAgent({} as Env, { sessionId: "protocol-test", modelId: `opencode-go/${id}`, systemPrompt: "Use check", getGoKey: async () => "key",
      tools: [{ name: "check", label: "Check", description: "Check", parameters: Type.Object({}), execute }] });
    await agent.prompt("Check");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain("tool worked");
    expect(completionError(agent.state.messages)).toBeUndefined();
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain("Done");
  });
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
