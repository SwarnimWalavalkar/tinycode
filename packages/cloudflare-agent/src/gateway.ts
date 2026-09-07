import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Env } from "./env.js";

export type GatewayApi = "openai-responses" | "openai-completions";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type GatewayDefinition = {
  id: string;
  name: string;
  api: GatewayApi;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: (typeof THINKING_LEVELS)[number][];
};

export function gatewayEndpoint(env: Env): string {
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? ""))
    throw new Error("Configure CLOUDFLARE_ACCOUNT_ID with your 32-character account ID");
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`;
}

export function gatewayHeaders(env: Env): Record<string, string> {
  const gateway = env.CLOUDFLARE_GATEWAY_ID ?? "default";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(gateway)) throw new Error("Invalid CLOUDFLARE_GATEWAY_ID");
  return { "cf-aig-gateway-id": gateway, "cf-aig-skip-cache": "true" };
}

export function gatewayCredential(env: Env): string {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured");
  gatewayEndpoint(env);
  gatewayHeaders(env);
  return token;
}

/** Deployment-owned metadata, not a claim that every gateway model supports every feature. */
export function customDefinitions(env: Env): GatewayDefinition[] {
  let value: unknown;
  try {
    value = JSON.parse(env.TINYCODE_GATEWAY_MODELS ?? "[]");
  } catch {
    throw new Error("TINYCODE_GATEWAY_MODELS must be a JSON array");
  }
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Configure up to 100 gateway model definitions");
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error("Invalid gateway model definition");
    const v = row as Record<string, unknown>;
    if (
      typeof v.id !== "string" ||
      !/^(?:@cf\/)?[a-zA-Z0-9_-]+\/[a-zA-Z0-9._:-]+$/.test(v.id) ||
      ids.has(v.id)
    )
      throw new Error("Gateway models need unique author/model or @cf/author/model IDs");
    if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 120)
      throw new Error("Gateway models need a display name");
    if (v.api !== "openai-responses" && v.api !== "openai-completions")
      throw new Error("Choose openai-responses or openai-completions for a gateway model");
    if (
      !Array.isArray(v.input) ||
      !v.input.includes("text") ||
      v.input.some((i) => i !== "text" && i !== "image")
    )
      throw new Error("Declare text and optionally image inputs");
    if (
      !Number.isSafeInteger(v.contextWindow) ||
      Number(v.contextWindow) < 1 ||
      !Number.isSafeInteger(v.maxTokens) ||
      Number(v.maxTokens) < 1 ||
      Number(v.maxTokens) > Number(v.contextWindow)
    )
      throw new Error("Declare valid contextWindow and maxTokens limits");
    if (
      !Array.isArray(v.thinkingLevels) ||
      new Set(v.thinkingLevels).size !== v.thinkingLevels.length ||
      v.thinkingLevels.some((level) => !THINKING_LEVELS.includes(level))
    )
      throw new Error("Declare supported thinkingLevels, or [] for no reasoning control");
    ids.add(v.id);
    return v as GatewayDefinition;
  });
}

export function modelDefinition(env: Env, id: string): GatewayDefinition {
  const configured = customDefinitions(env).find((model) => model.id === id);
  if (configured) return configured;
  // Preserve existing task IDs. Pi supplies metadata only; no OpenAI credentials or transport are used.
  const native = id.startsWith("openai/")
    ? openaiProvider()
        .getModels()
        .find((m) => m.id === id.slice(7))
    : undefined;
  if (!native) throw new Error(`Declare capabilities for ${id} in TINYCODE_GATEWAY_MODELS`);
  return {
    id,
    name: native.name,
    api: "openai-responses",
    input: native.input,
    contextWindow: native.contextWindow,
    maxTokens: native.maxTokens,
    thinkingLevels: native.reasoning
      ? THINKING_LEVELS.filter(
          (level) => native.thinkingLevelMap?.[level as ModelThinkingLevel] !== null,
        )
      : [],
  };
}

export function gatewayModel(env: Env, id: string): Model<GatewayApi> {
  const definition = modelDefinition(env, id);
  return {
    ...definition,
    provider: "tinycode-ai-gateway",
    baseUrl: gatewayEndpoint(env),
    headers: gatewayHeaders(env),
    reasoning: definition.thinkingLevels.some((level) => level !== "off"),
    // Gateway pricing differs from direct-provider pricing. Do not report guessed costs.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat:
      definition.api === "openai-completions"
        ? {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: definition.thinkingLevels.length > 0,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
          }
        : { supportsStrictMode: false, supportsLongCacheRetention: false },
  };
}
