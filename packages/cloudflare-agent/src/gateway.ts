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
  return {
    "cf-aig-gateway-id": gateway,
    "cf-aig-skip-cache": "true",
    "cf-aig-collect-log-payload": "false",
  };
}

export function gatewayCredential(env: Env): string {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured");
  gatewayEndpoint(env);
  gatewayHeaders(env);
  return token;
}

/** Reviewed capabilities live in code; deployment variables only select model IDs. */
const MODEL_CATALOG: GatewayDefinition[] = [
  {
    id: "@cf/zai-org/glm-5.3-flash",
    name: "GLM 5.3 Flash (Workers AI)",
    api: "openai-completions",
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 8192,
    thinkingLevels: [],
  },
  {
    id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash (Workers AI)",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 1310720,
    maxTokens: 8192,
    thinkingLevels: [],
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    name: "GPT OSS 20B (Workers AI)",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    thinkingLevels: [],
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    name: "GPT OSS 120B (Workers AI)",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    thinkingLevels: [],
  },
];

export function modelDefinition(_env: Env, id: string): GatewayDefinition {
  const configured = MODEL_CATALOG.find((model) => model.id === id);
  if (configured) return configured;
  // Preserve existing task IDs. Pi supplies metadata only; no OpenAI credentials or transport are used.
  const native = id.startsWith("openai/")
    ? openaiProvider()
        .getModels()
        .find((m) => m.id === id.slice(7))
    : undefined;
  if (!native)
    throw new Error(`Unknown gateway model: ${id}; add reviewed capabilities to MODEL_CATALOG`);
  if (native.api !== "openai-responses" && native.api !== "openai-completions")
    throw new Error("Unsupported native model protocol");
  return {
    id,
    name: native.name,
    api: native.api,
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
