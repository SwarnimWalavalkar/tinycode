import type { ProviderInfo, ThinkingOptions } from "../../shared/contracts.js";
import { modelCatalog } from "./models.js";
import { JsonLines } from "./jsonl.js";

async function discover(
  provider: ProviderInfo,
  cwd: string,
  model: string | null,
): Promise<ThinkingOptions> {
  if (!provider.available) throw new Error(`${provider.name} is not installed on this server`);
  if (provider.id !== "pi") {
    const catalog = await modelCatalog(provider, cwd);
    const selected = catalog.models.find(
      (m) => m.id === (model || catalog.defaultModel) || m.resolvedId === model,
    );
    const levels = selected?.thinkingLevels ?? [];
    const defaultLevel = selected?.defaultThinkingLevel ?? null;
    return {
      levels,
      defaultLevel: defaultLevel && levels.includes(defaultLevel) ? defaultLevel : null,
    };
  }
  // Ask an ephemeral Pi process about this model, without a prompt, saved session,
  // or changes to the user's global model/thinking preferences.
  const rpc = new JsonLines(
    provider.command,
    ["--mode", "rpc", "--no-session", ...(model ? ["--model", model] : [])],
    cwd,
  );
  rpc.onMessage = (m) => {
    if (m.type === "extension_ui_request")
      rpc.send({ type: "extension_ui_response", id: m.id, cancelled: true });
  };
  try {
    const [options, state] = await Promise.all([
      rpc.request({ type: "get_available_thinking_levels" }, 15000),
      rpc.request({ type: "get_state" }, 15000),
    ]);
    return { levels: options.levels ?? [], defaultLevel: state.thinkingLevel ?? null };
  } finally {
    rpc.dispose();
  }
}

const cache = new Map<string, { expires: number; value: Promise<ThinkingOptions> }>();
export function thinkingOptions(
  provider: ProviderInfo,
  cwd: string,
  model: string | null,
): Promise<ThinkingOptions> {
  const key = JSON.stringify([provider.id, provider.command, cwd, model]);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = discover(provider, cwd, model).catch((error) => {
    cache.delete(key);
    throw error;
  });
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 60000, value });
  return value;
}
