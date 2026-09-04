import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { ModelCatalog, ProviderId, ProviderInfo } from "../shared/contracts";
import { modelLabel } from "../shared/models";
import { api, setShell, useShell } from "./state";
import { ProviderMark, providerNames } from "./Harness";
import ThinkingPicker from "./ThinkingPicker";
import PermissionsPicker from "./PermissionsPicker";
import type { PermissionMode } from "../shared/permissions";

export default function ModelPicker({
  provider,
  model,
  resolvedModel,
  projectId,
  taskId,
  disabled,
  onChange,
  thinkingLevel,
  onThinkingChange,
  permissionMode,
  onPermissionsChange,
}: {
  provider: ProviderId;
  model: string | null;
  resolvedModel?: string | null;
  projectId?: string;
  taskId?: string;
  disabled?: boolean;
  onChange: (provider: ProviderId, model: string) => void | Promise<void>;
  thinkingLevel: string | null;
  onThinkingChange: (level: string | null) => void | Promise<void>;
  permissionMode?: PermissionMode | null;
  onPermissionsChange: (mode: PermissionMode) => void | Promise<void>;
}) {
  const { providers } = useShell();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    catalog?: ModelCatalog;
    error?: string;
  }>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const key = JSON.stringify([provider, projectId, taskId, retry]);
  const catalog = result?.key === key ? result.catalog : undefined;
  const error = result?.key === key ? result.error : undefined;
  const available = providers.find((p) => p.id === provider)?.available;
  const readyProviders = providers.filter((p) => p.available);
  const checking = !providers.length || providers.some((p) => p.readiness === "checking");
  const loading = available && !catalog && !error;
  useEffect(() => {
    if (!available) return;
    const abort = new AbortController();
    const params = new URLSearchParams({
      provider,
      ...(taskId ? { taskId } : projectId ? { projectId } : {}),
    });
    void api<ModelCatalog>(`/models?${params}`, { signal: abort.signal }).then(
      (catalog) => {
        if (!abort.signal.aborted) setResult({ key, catalog });
      },
      (error) => {
        if (!abort.signal.aborted)
          setResult({ key, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => abort.abort();
  }, [key, provider, projectId, taskId, available]);
  useEffect(() => {
    if (!taskId && !model && catalog?.defaultModel) void onChange(provider, catalog.defaultModel);
  }, [catalog, model, provider, taskId, onChange]);
  useEffect(() => {
    if (!open) return;
    // Refresh native auth in the background; a slow harness must not delay typing or sending.
    void api<ProviderInfo[]>("/providers").catch(() => {});
    searchInput.current?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const selectedId = resolvedModel || model;
  const selected =
    catalog?.models.find((m) => m.id === selectedId || m.resolvedId === selectedId) ??
    catalog?.models.find((m) => m.id === model);
  const label =
    selected?.label ??
    (selectedId ? modelLabel(selectedId) : loading ? "Loading models…" : "Choose model");
  const models = (catalog?.models ?? []).filter((m) =>
    `${m.label} ${m.id} ${m.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function choose(id: string) {
    if (!available) return;
    setSaving(true);
    setSaveError("");
    try {
      await onChange(provider, id);
      setOpen(false);
      setSearch("");
      trigger.current?.focus();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  async function refresh() {
    setRefreshing(true);
    setSaveError("");
    try {
      const providers = await api<ProviderInfo[]>("/providers", {
        method: "POST",
      });
      setShell({ providers });
      setRetry((n) => n + 1);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="composer-settings">
      <div className="model-picker" ref={root}>
        <button
          ref={trigger}
          className="model-trigger"
          type="button"
          aria-label={
            !taskId && !available
              ? "Connect a harness"
              : `Harness and model: ${providerNames[provider]}, ${label}`
          }
          aria-haspopup="dialog"
          aria-expanded={open}
          title={
            !taskId && !available
              ? "Connect a harness"
              : `${providerNames[provider]} · ${selectedId ?? label}${disabled ? " · Available after this turn" : ""}`
          }
          onClick={() => {
            setOpen((v) => !v);
            setSearch("");
            setSaveError("");
          }}
          disabled={disabled}
        >
          {!taskId && !available ? (
            <span>{checking ? "Checking harnesses…" : "Connect a harness"}</span>
          ) : (
            <>
              <ProviderMark id={provider} />
              <span className="model-harness">{providerNames[provider]}</span>
              <span className="model-separator">/</span>
              <span className="model-value">{label}</span>
            </>
          )}
          <ChevronDown size={12} />
        </button>
        {open && (
          <div
            className="model-menu"
            role="dialog"
            aria-label="Choose harness and model"
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                !root.current?.contains(event.relatedTarget as Node)
              )
                setOpen(false);
            }}
          >
            {!taskId ? (
              <div className="model-providers" role="group" aria-label="Harness">
                {readyProviders.map(({ id }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={provider === id}
                    disabled={saving}
                    title={providerNames[id]}
                    onClick={() => {
                      setSearch("");
                      if (id !== provider) void onChange(id, "");
                      searchInput.current?.focus();
                    }}
                  >
                    <ProviderMark id={id} />
                    {providerNames[id]}
                  </button>
                ))}
              </div>
            ) : (
              <div className="model-menu-heading">
                <ProviderMark id={provider} />
                {providerNames[provider]}
              </div>
            )}
            {available && (
              <div className="model-search">
                <Search size={15} />
                <input
                  ref={searchInput}
                  aria-label="Search models"
                  placeholder="Search models or enter an ID"
                  value={search}
                  maxLength={200}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      root.current
                        ?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
                        ?.focus();
                    }
                    if (e.key === "Enter" && search.trim() && !models.length && !loading) {
                      e.preventDefault();
                      void choose(search.trim());
                    }
                  }}
                />
              </div>
            )}
            <div
              className="model-options"
              role="menu"
              aria-label="Models"
              onKeyDown={(e) => {
                const options = Array.from(
                  e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
                );
                const at = options.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && options.length) {
                  e.preventDefault();
                  const next =
                    e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? options.length - 1
                        : e.key === "ArrowDown"
                          ? (at + 1) % options.length
                          : (at - 1 + options.length) % options.length;
                  options[next]?.focus();
                }
              }}
            >
              {loading && (
                <p className="model-message">
                  <LoaderCircle size={14} className="spin" />
                  Loading models…
                </p>
              )}
              {error && (
                <div className="model-message" role="alert">
                  <p>{error}</p>
                  <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
                </div>
              )}
              {!available && (
                <p className="model-message">
                  {checking
                    ? "Checking harness authentication…"
                    : taskId
                      ? provider === "cloudflare"
                        ? "Check the Cloudflare Worker URL, transport token, and readiness, then refresh."
                        : "Sign in to this task’s harness on the server, then refresh."
                      : "Sign in to a local harness or configure the Cloudflare Worker, then refresh."}
                </p>
              )}
              {available &&
                models.map((m) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={
                      m.id === model || m.id === selectedId || m.resolvedId === selectedId
                    }
                    disabled={saving}
                    key={m.id}
                    title={m.description ?? m.id}
                    onClick={() => void choose(m.id)}
                  >
                    <span>
                      {m.label}
                      {provider === "pi" && <small>{m.description}</small>}
                    </span>
                    {(m.id === model || m.id === selectedId || m.resolvedId === selectedId) && (
                      <Check size={14} />
                    )}
                  </button>
                ))}
              {catalog && !models.length && !search && (
                <p className="model-message">No models available. Enter a model ID above.</p>
              )}
            </div>
            {available && search.trim() && !models.length && !loading && (
              <button
                className="custom-model"
                disabled={saving}
                onClick={() => void choose(search.trim())}
              >
                Use model ID <strong>{search.trim()}</strong>
              </button>
            )}
            {saveError && (
              <p className="model-message" role="alert">
                {saveError}
              </p>
            )}
            <button
              type="button"
              className="refresh-harnesses"
              disabled={refreshing || checking}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} className={refreshing ? "spin" : ""} />
              {refreshing ? "Checking…" : "Refresh harnesses"}
            </button>
          </div>
        )}
      </div>
      {available && (
        <ThinkingPicker
          provider={provider}
          model={model || resolvedModel || null}
          value={thinkingLevel}
          projectId={projectId}
          taskId={taskId}
          disabled={disabled || saving}
          onChange={onThinkingChange}
        />
      )}
      {available && (
        <PermissionsPicker
          provider={provider}
          value={permissionMode}
          disabled={disabled}
          onChange={onPermissionsChange}
          autoModeAvailable={
            (
              selected ??
              (!selectedId ? catalog?.models.find((m) => m.id === catalog.defaultModel) : undefined)
            )?.supportsAutoMode
          }
        />
      )}
    </div>
  );
}
