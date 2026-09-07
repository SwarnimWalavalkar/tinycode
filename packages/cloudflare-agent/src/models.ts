import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelCatalog } from "../../../src/shared/contracts.js";
import type { Env } from "./env.js";

import { gatewayCredential, gatewayModel, modelDefinition } from "./gateway.js";
import { workersAiFetch } from "./workers-ai.js";

export function configuredModelIds(env: Env): string[] {
  const ids = (env.TINYCODE_MODELS ?? env.TINYCODE_DEFAULT_MODEL ?? "openai/gpt-5.4")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const fallback = env.TINYCODE_DEFAULT_MODEL?.trim();
  if (fallback && !ids.includes(fallback)) ids.unshift(fallback);
  return [...new Set(ids)];
}

export function completionError(messages: AgentMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return "The model stopped without a final answer. Please retry.";
  if (last.stopReason === "length") return "The model reached its output limit before finishing. Please retry.";
  if (last.stopReason !== "stop") return last.errorMessage || "The model did not finish its response. Please retry.";
  if (!last.content.some(part => part.type === "text" && part.text.trim()))
    return "The model returned no final answer. Please retry or choose another model.";
}

export function defaultModelId(env: Env): string {
  return env.TINYCODE_DEFAULT_MODEL?.trim() || configuredModelIds(env)[0] || "openai/gpt-5.4";
}

export function resolveModel(env: Env, id: string) {
  if (!configuredModelIds(env).includes(id)) throw new Error("Model is not enabled for this agent");
  return { model: gatewayModel(env, id) };
}

export function modelCatalog(env: Env): ModelCatalog {
  const available = configuredModelIds(env).map((id) => {
    const model = modelDefinition(env, id);
    return {
      id,
      label: model.name,
      description: `Pi SDK · AI Gateway · ${id.startsWith("@cf/") ? "Workers AI" : "external model"}`,
      thinkingLevels: model.thinkingLevels,
      defaultThinkingLevel: model.thinkingLevels.includes("medium")
        ? "medium"
        : (model.thinkingLevels[0] ?? null),
    };
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
  const levels = modelDefinition(env, modelId).thinkingLevels;
  if (!levels.length) {
    if (value != null && value !== "off")
      throw new Error("This gateway model has no configurable thinking levels");
    return "off";
  }
  if (value != null && !levels.some((level) => level === value))
    throw new Error("Thinking level is not supported by this gateway model");
  return (value as ThinkingLevel) ?? (levels.includes("medium") ? "medium" : levels[0]);
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
  const credential = gatewayCredential(env);
  const { model } = resolveModel(env, input.modelId);
  const thinking = normalizeThinkingLevel(env, input.modelId, input.thinkingLevel);
  return new Agent({
    sessionId: input.sessionId,
    getApiKey: async () => credential,
    streamFn: (_model, context, options) => {
      if (
        !model.input.includes("image") &&
        context.messages.some(
          (message) =>
            Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
        )
      )
        throw new Error(
          "This gateway model does not support image inputs; choose an image-capable model",
        );
      const settings = {
        ...options,
        apiKey: credential,
        ...(model.id.startsWith("@cf/") ? { fetch: workersAiFetch } : {}),
        headers: { ...options?.headers, ...model.headers },
        onPayload: async (payload: unknown) => {
          const next = (await options?.onPayload?.(payload, model)) ?? payload;
          // Workers AI's GPT OSS Gateway adapter rejects null assistant content
          // when replaying a tool call, although Chat Completions permits it.
          if (model.id.startsWith("@cf/") && model.api === "openai-completions") {
            const body = next as {
              messages?: {
                role: string;
                content?: unknown;
                tool_calls?: unknown[];
              }[];
            };
            for (const message of body.messages ?? []) {
              if (
                message.role === "assistant" &&
                message.content === null &&
                message.tool_calls?.length
              )
                message.content = "";
            }
          }
          return next;
        },
      };
      return model.api === "openai-responses"
        ? responses(model as Model<"openai-responses">, context, settings)
        : completions(model as Model<"openai-completions">, context, settings);
    },
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
