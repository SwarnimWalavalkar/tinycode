import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelCatalog } from "../../../src/shared/contracts.js";
import type { Env } from "./env.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function configuredModelIds(env: Env): string[] {
  const ids = (env.TINYCODE_MODELS ?? env.TINYCODE_DEFAULT_MODEL ?? "openai/gpt-5.4")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const fallback = env.TINYCODE_DEFAULT_MODEL?.trim();
  if (fallback && !ids.includes(fallback)) ids.unshift(fallback);
  return [...new Set(ids)];
}

export function defaultModelId(env: Env): string {
  return env.TINYCODE_DEFAULT_MODEL?.trim() || configuredModelIds(env)[0] || "openai/gpt-5.4";
}

function collection() {
  const models = createModels();
  models.setProvider(openaiProvider());
  return models;
}

export function resolveModel(
  env: Env,
  id: string,
): { models: ReturnType<typeof collection>; model: Model<Api> } {
  if (!configuredModelIds(env).includes(id)) throw new Error("Model is not enabled for this agent");
  const slash = id.indexOf("/");
  const provider = slash < 1 ? "" : id.slice(0, slash);
  const modelId = slash < 1 ? "" : id.slice(slash + 1);
  if (provider !== "openai" || !modelId) throw new Error("Only OpenAI models are supported initially");
  const models = collection();
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`Pi does not recognize model ${id}`);
  return { models, model };
}

export function modelCatalog(env: Env): ModelCatalog {
  const available = configuredModelIds(env).flatMap((id) => {
    try {
      const { model } = resolveModel(env, id);
      return [{
        id,
        label: model.name,
        description: "Pi SDK · OpenAI · Durable Object",
        thinkingLevels: model.reasoning ? [...THINKING_LEVELS] : [],
        defaultThinkingLevel: model.reasoning ? "medium" : null,
      }];
    } catch {
      return [];
    }
  });
  const preferred = defaultModelId(env);
  return {
    models: available,
    defaultModel: available.some((model) => model.id === preferred)
      ? preferred
      : (available[0]?.id ?? null),
  };
}

export function normalizeThinkingLevel(
  env: Env,
  modelId: string,
  value?: string | null,
): ThinkingLevel {
  const { model } = resolveModel(env, modelId);
  if (!model.reasoning) return "off";
  return THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number])
    ? (value as ThinkingLevel)
    : "medium";
}

export function createPiAgent(
  env: Env,
  input: {
    sessionId: string;
    modelId: string;
    systemPrompt: string;
    thinkingLevel?: string | null;
    messages?: AgentMessage[];
    tools?: AgentTool<any>[];
  },
) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const { models, model } = resolveModel(env, input.modelId);
  const thinking = normalizeThinkingLevel(env, input.modelId, input.thinkingLevel);
  return new Agent({
    sessionId: input.sessionId,
    getApiKey: async () => env.OPENAI_API_KEY,
    streamFn: models.streamSimple.bind(models),
    toolExecution: "parallel",
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      thinkingLevel: thinking,
      tools: input.tools ?? [],
      messages: input.messages ?? [],
    },
  });
}
