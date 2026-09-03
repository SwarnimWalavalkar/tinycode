import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCatalog, ModelOption, ProviderInfo } from "../../shared/contracts.js";
import { modelLabel } from "../../shared/models.js";
import { JsonLines } from "./jsonl.js";
import type { Native } from "./types.js";

async function discover(provider: ProviderInfo, cwd: string): Promise<ModelCatalog> {
  if (!provider.available) throw new Error(`${provider.name} is not installed on this server`);
  if (provider.id === "claude") {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        await gate;
      },
    };
    const session = query({
      prompt,
      options: {
        cwd,
        pathToClaudeCodeExecutable: provider.command,
        persistSession: false,
        settingSources: ["user", "project", "local"],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "TINYCODE_TOKEN"),
        ),
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const native = await Promise.race([
        session.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Claude model discovery timed out")), 15000);
        }),
      ]);
      const models = native
        .filter((m) => m.value !== "default")
        .map((m) => ({
          id: m.value,
          label: m.resolvedModel ? modelLabel(m.resolvedModel) : m.displayName,
          resolvedId: m.resolvedModel,
          description: m.description,
          thinkingLevels: m.supportedEffortLevels ?? [],
          supportsAutoMode: m.supportsAutoMode === true,
        }));
      const defaultId = native.find((m) => m.value === "default")?.resolvedModel;
      return {
        models,
        defaultModel: models.find((m) => m.resolvedId === defaultId)?.id ?? models[0]?.id ?? null,
      };
    } finally {
      clearTimeout(timer);
      release();
      session.close();
    }
  }
  const rpc = new JsonLines(
    provider.command,
    provider.id === "codex"
      ? ["app-server", "--listen", "stdio://"]
      : ["--mode", "rpc", "--no-session"],
    cwd,
  );
  // Catalog discovery never supplies a prompt or grants native permission requests.
  rpc.onMessage = (m) => {
    if (m.method && m.id !== undefined)
      rpc.send({ id: m.id, error: { code: -32601, message: "Catalog discovery only" } });
    if (m.type === "extension_ui_request")
      rpc.send({ type: "extension_ui_response", id: m.id, cancelled: true });
  };
  const request = (method: string, params: object = {}) => rpc.request({ method, params }, 15000);
  try {
    if (provider.id === "codex") {
      await request("initialize", {
        clientInfo: { name: "tinycode", title: "Tinycode", version: "0.1.0" },
        capabilities: {},
      });
      rpc.send({ method: "initialized" });
      const [catalog, settings] = await Promise.all([
        request("model/list"),
        request("config/read", { cwd }),
      ]);
      const native: Native[] = catalog.data ?? [];
      const models: ModelOption[] = native
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.model ?? m.id,
          label: modelLabel(m.displayName ?? m.model ?? m.id),
          description: m.description,
          thinkingLevels: (m.supportedReasoningEfforts ?? []).map((e: Native) => e.reasoningEffort),
          defaultThinkingLevel:
            settings.config?.model_reasoning_effort ?? m.defaultReasoningEffort ?? null,
        }));
      const defaultModel =
        settings.config?.model ??
        native.find((m) => m.isDefault)?.model ??
        native.find((m) => m.isDefault)?.id ??
        models[0]?.id ??
        null;
      if (defaultModel && !models.some((m) => m.id === defaultModel))
        models.unshift({ id: defaultModel, label: modelLabel(defaultModel) });
      return { models, defaultModel };
    }
    const [catalog, state] = await Promise.all([
      rpc.request({ type: "get_available_models" }, 15000),
      rpc.request({ type: "get_state" }, 15000),
    ]);
    return {
      models: (catalog.models ?? []).map((m: Native) => ({
        id: `${m.provider}/${m.id}`,
        label: m.name ?? modelLabel(m.id),
        description: m.provider,
      })),
      defaultModel: state.model ? `${state.model.provider}/${state.model.id}` : null,
    };
  } finally {
    rpc.dispose();
  }
}

// Lazy, bounded, shared across browser attachments; discovery never delays bootstrap.
const cache = new Map<string, { expires: number; value: Promise<ModelCatalog> }>();
export function modelCatalog(provider: ProviderInfo, cwd: string): Promise<ModelCatalog> {
  const key = JSON.stringify([provider.id, provider.command, cwd]);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = discover(provider, cwd).catch((error) => {
    cache.delete(key);
    throw error;
  });
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 60000, value });
  return value;
}
