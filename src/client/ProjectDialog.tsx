import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, Home, LoaderCircle, ArrowRight } from "lucide-react";
import type { DirectoryListing, Project } from "../shared/contracts";
import { api } from "./state";
import Dialog from "./Dialog";

export default function ProjectDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (p: Project) => void;
}) {
  const [path, setPath] = useState("~");
  const [location, setLocation] = useState("~");
  const [listing, setListing] = useState<DirectoryListing>();
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const pathRef = useRef<HTMLInputElement>(null);
  const draftVersion = useRef(0);
  const adding = useRef<AbortController | null>(null);
  useEffect(() => () => adding.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    const startedWithDraft = draftVersion.current;
    setLoading(true);
    setError("");
    void api<DirectoryListing>(
      `/directories?${new URLSearchParams({ path: location, hidden: String(hidden) })}`,
      { signal: abort.signal },
    )
      .then(
        (result) => {
          if (abort.signal.aborted) return;
          setListing(result);
          if (draftVersion.current === startedWithDraft) setPath(result.path);
        },
        (error) => {
          if (!abort.signal.aborted)
            setError(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [location, hidden, revision]);
  function browse(next: string) {
    if (busy) return;
    draftVersion.current++;
    setPath(next);
    setLocation(next);
    setRevision((n) => n + 1);
  }
  async function add() {
    if (busy || loading || !path.trim()) return;
    const abort = new AbortController();
    adding.current = abort;
    setBusy(true);
    setError("");
    try {
      const project = await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ path: path.trim() }),
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        onAdd(project);
        onClose();
      }
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog title="Open a project" onClose={onClose}>
      <div className="project-browser">
        <p>Choose a folder on the connected server.</p>
        <form
          className="directory-path"
          onSubmit={(event) => {
            event.preventDefault();
            browse(path.trim() || "~");
          }}
        >
          <input
            ref={pathRef}
            aria-label="Folder path"
            autoFocus
            value={path}
            disabled={busy}
            onChange={(event) => {
              draftVersion.current++;
              setPath(event.target.value);
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            className="icon-button"
            title="Go to folder"
            aria-label="Go to folder"
            disabled={busy}
          >
            <ArrowRight size={16} />
          </button>
        </form>
        <div className="directory-toolbar">
          <button
            className="icon-button"
            title="Home directory"
            aria-label="Home directory"
            disabled={busy || loading}
            onClick={() => browse(listing?.home ?? "~")}
          >
            <Home size={16} />
          </button>
          <button
            className="icon-button"
            title="Parent directory"
            aria-label="Parent directory"
            disabled={busy || loading || !listing?.parent}
            onClick={() => browse(listing!.parent!)}
          >
            <ArrowUp size={16} />
          </button>
          <label>
            <input
              type="checkbox"
              checked={hidden}
              disabled={busy || loading}
              onChange={(e) => setHidden(e.target.checked)}
            />
            Show hidden folders
          </label>
        </div>
        <div className="directory-list" aria-label="Server folders" aria-busy={loading}>
          {loading ? (
            <div className="directory-empty">
              <LoaderCircle size={18} className="spin" />
              Loading folders…
            </div>
          ) : listing?.directories.length ? (
            listing.directories.map((directory) => (
              <button
                key={directory.path}
                className="directory-row"
                disabled={busy}
                onClick={() => browse(directory.path)}
              >
                <Folder size={16} />
                <span>{directory.name}</span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <div className="directory-empty">
              {error ? "Couldn’t open this folder" : "No subfolders"}
            </div>
          )}
        </div>
        {listing?.truncated && (
          <p className="directory-note">
            Showing the first 500 folders. Enter a path to go directly to a folder.
          </p>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || loading || !path.trim()}
            onClick={() => void add()}
          >
            {busy && <LoaderCircle size={15} className="spin" />}Open project
          </button>
        </div>
      </div>
    </Dialog>
  );
}
