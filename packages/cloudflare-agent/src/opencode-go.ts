import type { Model } from "@earendil-works/pi-ai";
import { HttpError } from "./http.js";

export const GO_PREFIX = "opencode-go/";
export const GO_DEFAULT = `${GO_PREFIX}glm-5.3-flash`;
export const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
// A deliberately small, reviewed Chat Completions catalog. Conservative output caps.
export const GO_MODELS = [
  { id: GO_DEFAULT, name: "GLM 5.3 Flash", contextWindow: 1_048_576, input: ["text", "image"] },
  { id: `${GO_PREFIX}glm-5.3`, name: "GLM 5.3", contextWindow: 1_048_576, input: ["text"] },
  { id: `${GO_PREFIX}deepseek-v4-flash`, name: "DeepSeek V4 Flash", contextWindow: 1_048_576, input: ["text"] },
] as const;

export const isGoModel = (id: string) => id.startsWith(GO_PREFIX);
export function goModel(id: string): Model<"openai-completions"> {
  const definition = GO_MODELS.find((model) => model.id === id);
  if (!definition) throw new HttpError(400, "Choose an available OpenCode Go model");
  return {
    ...definition,
    id: definition.id.slice(GO_PREFIX.length),
    input: [...definition.input],
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: GO_BASE_URL,
    maxTokens: 8192,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
  };
}

/** Do not expose upstream bodies, which may include request data or credentials. */
export const goFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (response.ok) return response;
  await response.body?.cancel();
  const message = response.status === 401 || response.status === 403
    ? "OpenCode Go rejected your key. Update it in the model picker."
    : response.status === 429
      ? "OpenCode Go is at its usage or rate limit. Check your usage in the OpenCode console, then retry when capacity is available."
      : response.status === 402
        ? "OpenCode Go has no usage available. Check your subscription in the OpenCode console."
        : "OpenCode Go could not complete this request. Please retry or choose another model.";
  return Response.json({ error: { message, type: "provider_error" } }, { status: response.status });
};
