import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import Dialog from "./Dialog";
import {
  checkConnection,
  connection,
  defaultServerUrl,
  normalizeServerUrl,
  readToken,
  saveConnection,
} from "./connection";

export default function ConnectionDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState(connection.url);
  const [name, setName] = useState(connection.name);
  const [token, setToken] = useState(() => readToken());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    urlInput.current?.focus();
    return () => request.current?.abort();
  }, []);
  function changeUrl(value: string) {
    setUrl(value);
    setError("");
    try {
      setToken(readToken(normalizeServerUrl(value)));
    } catch {
      setToken("");
    }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const settings = { url: normalizeServerUrl(url), name: name.trim() };
      await checkConnection(settings, token.trim(), controller.signal);
      if (!controller.signal.aborted) saveConnection(settings, token.trim());
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : String(error));
        setBusy(false);
      }
    }
  }
  return (
    <Dialog title="Server connection" onClose={onClose}>
      <form className="connection-form" onSubmit={(event) => void connect(event)}>
        <p>Connect to Tinycode on this machine or another server.</p>
        <label htmlFor="server-url">Server URL</label>
        <input
          id="server-url"
          ref={urlInput}
          type="url"
          required
          autoFocus
          value={url}
          onChange={(event) => changeUrl(event.target.value)}
          disabled={busy}
          placeholder="http://localhost:4738"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="url"
        />
        <label htmlFor="server-name">
          Name <span className="muted">optional</span>
        </label>
        <input
          id="server-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          placeholder="Defaults to the server hostname"
          autoComplete="off"
        />
        <label htmlFor="server-token">
          Access token <span className="muted">if required</span>
        </label>
        <input
          id="server-token"
          type="password"
          value={token}
          maxLength={4096}
          onChange={(event) => setToken(event.target.value)}
          disabled={busy}
          autoComplete="off"
        />
        <p className="connection-note">
          The token stays in this browser tab. Switching servers clears unsent drafts; running tasks
          continue.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button connection-default"
            disabled={busy}
            onClick={() => {
              changeUrl(defaultServerUrl);
              setName("");
            }}
          >
            Use default
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" />}
            {busy ? "Checking…" : "Connect"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
