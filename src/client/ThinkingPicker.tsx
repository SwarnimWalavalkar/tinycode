import { useEffect, useState } from "react";
import { ChevronDown, RotateCw } from "lucide-react";
import type { ProviderId, ThinkingOptions } from "../shared/contracts";
import { thinkingLabel } from "../shared/thinking";
import { api, setShell } from "./state";

export default function ThinkingPicker({
  provider,
  model,
  value,
  projectId,
  taskId,
  disabled,
  onChange,
}: {
  provider: ProviderId;
  model: string | null;
  value: string | null;
  projectId?: string;
  taskId?: string;
  disabled?: boolean;
  onChange: (level: string | null) => void | Promise<void>;
}) {
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    options?: ThinkingOptions;
    error?: string;
  }>();
  const key = JSON.stringify([provider, model, projectId, taskId, retry]);
  const options = result?.key === key ? result.options : undefined;
  const error = result?.key === key ? result.error : undefined;
  useEffect(() => {
    if (!model) return;
    const abort = new AbortController();
    const params = new URLSearchParams({
      provider,
      model,
      ...(taskId ? { taskId } : projectId ? { projectId } : {}),
    });
    void api<ThinkingOptions>(`/thinking?${params}`, { signal: abort.signal }).then(
      (options) => {
        if (!abort.signal.aborted) setResult({ key, options });
      },
      (error) => {
        if (!abort.signal.aborted)
          setResult({ key, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => abort.abort();
  }, [key, provider, model, projectId, taskId]);
  useEffect(() => {
    if (!taskId && value && options && !options.levels.includes(value)) void onChange(null);
  }, [taskId, value, options, onChange]);
  const label = value ? thinkingLabel(value) : "Default";
  const defaultLabel = options?.defaultLevel
    ? `Default (${thinkingLabel(options.defaultLevel)})`
    : "Default";
  if (error)
    return (
      <button
        type="button"
        className="thinking-picker"
        aria-label="Retry thinking levels"
        title={error}
        onClick={() => setRetry((n) => n + 1)}
      >
        {label} <RotateCw size={12} />
      </button>
    );
  const locked = disabled || saving || !options || options.levels.length === 0;
  return (
    <label
      className="thinking-picker"
      data-disabled={locked || undefined}
      title={`Thinking level: ${value ? label : defaultLabel}${options && !options.levels.length ? " · Not adjustable for this model" : ""}`}
    >
      <span aria-hidden="true">{label}</span>
      <ChevronDown size={12} aria-hidden="true" />
      <select
        aria-label="Thinking level"
        value={value ?? ""}
        disabled={locked}
        onChange={async (event) => {
          setSaving(true);
          try {
            await onChange(event.target.value || null);
          } catch (error) {
            setShell({ error: error instanceof Error ? error.message : String(error) });
          } finally {
            setSaving(false);
          }
        }}
      >
        <option value="">{defaultLabel}</option>
        {value && !options?.levels.includes(value) && <option value={value}>{label}</option>}
        {options?.levels.map((level) => (
          <option key={level} value={level}>
            {thinkingLabel(level)}
          </option>
        ))}
      </select>
    </label>
  );
}
