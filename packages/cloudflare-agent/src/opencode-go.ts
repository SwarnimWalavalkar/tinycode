import type { Model } from "@earendil-works/pi-ai";
import { HttpError } from "./http.js";

export const GO_PREFIX = "opencode-go/";
export const GO_DEFAULT = `${GO_PREFIX}glm-5.3-flash`;
export const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
// Snapshot of https://opencode.ai/zen/go/v1/models, 2026-09-11.
// Protocols: opencode.ai/docs/go/#endpoints. Capabilities: models.dev (opencode-go).
// Keep a local catalog so model selection and resumed tasks do not depend on discovery uptime.
export const GO_MODELS = [
  {"id": "opencode-go/glm-5.3-flash", "name": "GLM-5.3-Flash", "api": "openai-completions", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/deepseek-v4-flash", "name": "DeepSeek V4 Flash", "api": "openai-completions", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/deepseek-v4-flash-vision-exp", "name": "DeepSeek V4 Flash Vision Exp", "api": "openai-completions", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "api": "openai-completions", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "api": "openai-completions", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/deepseek-flash", "name": "DeepSeek Flash", "api": "openai-completions", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/glm-5", "name": "GLM-5", "api": "openai-completions", "contextWindow": 202752, "input": ["text"]},
  {"id": "opencode-go/glm-5.1", "name": "GLM-5.1", "api": "openai-completions", "contextWindow": 202752, "input": ["text"]},
  {"id": "opencode-go/glm-5.2", "name": "GLM-5.2", "api": "openai-completions", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/glm-5.3", "name": "GLM-5.3", "api": "openai-completions", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/gpt-5.6-luna", "name": "GPT-5.6 Luna", "api": "openai-responses", "contextWindow": 1050000, "input": ["text", "image"]},
  {"id": "opencode-go/grok-4.5", "name": "Grok 4.5", "api": "openai-responses", "contextWindow": 500000, "input": ["text", "image"]},
  {"id": "opencode-go/grok-4.6", "name": "Grok 4.6", "api": "openai-responses", "contextWindow": 500000, "input": ["text", "image"]},
  {"id": "opencode-go/hy3", "name": "Hy3", "api": "openai-completions", "contextWindow": 256000, "input": ["text"]},
  {"id": "opencode-go/hy3-preview", "name": "Hy3 Preview", "api": "openai-completions", "contextWindow": 256000, "input": ["text"]},
  {"id": "opencode-go/hy4-preview", "name": "Hy4 preview", "api": "openai-completions", "contextWindow": 1024000, "input": ["text"]},
  {"id": "opencode-go/kimi-k2.5", "name": "Kimi K2.5", "api": "openai-completions", "contextWindow": 262144, "input": ["text", "image"]},
  {"id": "opencode-go/kimi-k2.6", "name": "Kimi K2.6", "api": "openai-completions", "contextWindow": 262144, "input": ["text", "image"]},
  {"id": "opencode-go/kimi-k2.7-code", "name": "Kimi K2.7 Code", "api": "openai-completions", "contextWindow": 262144, "input": ["text", "image"]},
  {"id": "opencode-go/kimi-k3", "name": "Kimi K3", "api": "openai-completions", "contextWindow": 1048576, "input": ["text", "image"]},
  {"id": "opencode-go/longcat-2.0", "name": "LongCat-2.0", "api": "openai-completions", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/mimo-v2-omni", "name": "MiMo V2 Omni", "api": "openai-completions", "contextWindow": 262144, "input": ["text", "image"]},
  {"id": "opencode-go/mimo-v2-pro", "name": "MiMo V2 Pro", "api": "openai-completions", "contextWindow": 1048576, "input": ["text"]},
  {"id": "opencode-go/mimo-v2.5", "name": "MiMo V2.5", "api": "openai-completions", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/mimo-v2.5-pro", "name": "MiMo V2.5 Pro", "api": "openai-completions", "contextWindow": 1048576, "input": ["text"]},
  {"id": "opencode-go/minimax-m2.5", "name": "MiniMax-M2.5", "api": "anthropic-messages", "contextWindow": 204800, "input": ["text"]},
  {"id": "opencode-go/minimax-m2.7", "name": "MiniMax-M2.7", "api": "anthropic-messages", "contextWindow": 204800, "input": ["text"]},
  {"id": "opencode-go/minimax-m3", "name": "MiniMax-M3", "api": "anthropic-messages", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/muse-spark-1.2-contributor", "name": "Muse Spark 1.2 Contributor", "api": "openai-responses", "contextWindow": 1048576, "input": ["text", "image"]},
  {"id": "opencode-go/muse-spark-1.3-contributor", "name": "Muse Spark 1.3 Contributor", "api": "openai-responses", "contextWindow": 1048576, "input": ["text", "image"]},
  {"id": "opencode-go/omen-alpha", "name": "Omen Alpha", "api": "openai-completions", "contextWindow": 500000, "input": ["text", "image"]},
  {"id": "opencode-go/qwen3.5-plus", "name": "Qwen3.5 Plus", "api": "openai-completions", "contextWindow": 262144, "input": ["text", "image"]},
  {"id": "opencode-go/qwen3.6-plus", "name": "Qwen3.6 Plus", "api": "anthropic-messages", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/qwen3.7-max", "name": "Qwen3.7 Max", "api": "anthropic-messages", "contextWindow": 1000000, "input": ["text"]},
  {"id": "opencode-go/qwen3.7-plus", "name": "Qwen3.7 Plus", "api": "anthropic-messages", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/qwen3.8-flash", "name": "Qwen3.8 Flash", "api": "anthropic-messages", "contextWindow": 1000000, "input": ["text", "image"]},
  {"id": "opencode-go/qwen3.8-max", "name": "Qwen3.8 Max", "api": "anthropic-messages", "contextWindow": 1000000, "input": ["text", "image"]},
] as const;

export const isGoModel = (id: string) => id.startsWith(GO_PREFIX);
export function goModel(id: string): Model<"openai-completions" | "openai-responses" | "anthropic-messages"> {
  const definition = GO_MODELS.find((model) => model.id === id);
  if (!definition) throw new HttpError(400, "Choose an available OpenCode Go model");
  return {
    ...definition,
    id: definition.id.slice(GO_PREFIX.length),
    input: [...definition.input],
    provider: "opencode-go",
    api: definition.api,
    baseUrl: definition.api === "anthropic-messages" ? GO_BASE_URL.slice(0, -3) : GO_BASE_URL,
    maxTokens: 8192,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: definition.api === "openai-completions" ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" } : undefined,
  };
}

/** Do not expose upstream bodies, which may include request data or credentials. */
export const goFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.ok) return response;
  await response.body?.cancel();
  const message = response.status === 401 || response.status === 403
    ? "OpenCode Go rejected your key. Update it in the model picker."
    : response.status === 429
      ? "OpenCode Go is at its usage or rate limit. Check your usage in the OpenCode console, then retry when capacity is available."
      : response.status === 402
        ? "OpenCode Go has no usage available. Check your subscription in the OpenCode console."
        : "OpenCode Go could not complete this request. Please retry or choose another model.";
  return Response.json({ error: { message, type: "provider_error" } }, { status: response.status >= 300 && response.status < 400 ? 502 : response.status });
};
