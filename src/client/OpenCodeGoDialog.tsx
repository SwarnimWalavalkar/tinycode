import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import Dialog from "./Dialog";
import { api } from "./state";

interface ConnectionStatus { enabled: boolean; connected: boolean }
export default function OpenCodeGoDialog({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (connected: boolean, changed: boolean) => void;
}) {
  const alive = useRef(false);
  const [status, setStatus] = useState<ConnectionStatus>();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void api<ConnectionStatus>("/inference/opencode-go", { signal: abort.signal }).then(
      (value) => { if (!abort.signal.aborted) setStatus(value); },
      (error) => { if (!abort.signal.aborted) setError(error.message); },
    );
    return () => { alive.current = false; abort.abort(); };
  }, []);
  async function save(method: "PUT" | "DELETE") {
    if (busy || !status?.enabled || (method === "PUT" && !apiKey.trim())) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<ConnectionStatus>("/inference/opencode-go", {
        method,
        ...(method === "PUT" ? { body: JSON.stringify({ apiKey: apiKey.trim() }) } : {}),
      });
      if (!alive.current) return;
      setApiKey("");
      onSaved(next.connected, next.connected !== status?.connected);
    } catch (error) {
      if (!alive.current) return;
      setError(error instanceof Error ? error.message : "Could not save your key. Try again.");
    } finally { if (alive.current) setBusy(false); }
  }
  return (
    <Dialog title="OpenCode Go" onClose={onClose} busy={busy}>
      <form className="connection-form" onSubmit={(event) => { event.preventDefault(); void save("PUT"); }}>
        <p>Use your OpenCode Go subscription for your durable tasks.</p>
        <p><a href="https://opencode.ai/auth" target="_blank" rel="noreferrer">Get your API key from OpenCode ↗</a></p>
        {!status && !error && <p role="status">Loading connection…</p>}
        {status?.enabled === false && <p>This server needs inference key storage enabled by its administrator.</p>}
        {status?.enabled && <>
          {status.connected && <p>Your API key is saved. Paste a new key to replace it.</p>}
          <label htmlFor="opencode-go-key">API key</label>
          <input id="opencode-go-key" type="password" autoFocus required autoComplete="off" spellCheck={false}
            autoCapitalize="none" maxLength={4096} value={apiKey} disabled={busy}
            onChange={(event) => { setApiKey(event.target.value); setError(""); }} />
          <p className="connection-note">Your key is encrypted on this server and kept out of task sandboxes. Usage follows your OpenCode plan and balance settings.</p>
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {status?.connected && <button type="button" className="button" disabled={busy} onClick={() => void save("DELETE")}>Disconnect</button>}
          <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
          {status?.enabled && <button className="button primary" disabled={busy || !apiKey.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />}{busy ? "Saving…" : status.connected ? "Update key" : "Save and use OpenCode Go"}
          </button>}
        </div>
      </form>
    </Dialog>
  );
}
