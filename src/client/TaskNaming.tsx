import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { Task } from "../shared/contracts";
import { MAX_TASK_TITLE, type TitleSuggestion } from "../shared/titles";
import { api, getShell, post, setShell, selectTask } from "./state";
import Dialog from "./Dialog";

export interface TaskMenuPosition {
  task: Task;
  x: number;
  y: number;
  trigger: HTMLButtonElement;
}
export function TaskContextMenu({
  position,
  onClose,
  onRename,
  onDelete,
}: {
  position: TaskMenuPosition;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    menu.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector("button")?.focus();
  }, [position]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className="task-context-menu"
      role="menu"
      aria-label="Task actions"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const buttons = Array.from(ref.current!.querySelectorAll("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
        }
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <button role="menuitem" onClick={onRename}>
        <Pencil size={14} />
        Rename…
      </button>
      <button role="menuitem" className="destructive" onClick={onDelete}>
        <Trash2 size={14} />
        Delete session…
      </button>
    </div>,
    document.body,
  );
}

export function DeleteTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api(`/tasks/${task.id}`, { method: "DELETE" });
      if (getShell().activeTaskId === task.id) selectTask(null);
      setShell({ tasks: getShell().tasks.filter((t) => t.id !== task.id) });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  }
  return (
    <Dialog
      title="Delete session"
      className="delete-session-dialog"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <p className="delete-session-description">
        The conversation, queued messages, and attachments will be permanently deleted.
      </p>
      <p className="delete-session-note">
        {task.provider === "cloudflare"
          ? "The sandbox and all files inside it will also be deleted. Save anything you need first."
          : "Your local files and original harness history will stay. Any open session terminals will close."}
      </p>
      <p className="delete-session-warning">This cannot be undone.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button secondary" disabled={saving} onClick={onClose} autoFocus>
          Cancel
        </button>
        <button className="button destructive" disabled={saving} onClick={() => void remove()}>
          {saving ? "Deleting…" : "Delete session"}
        </button>
      </div>
    </Dialog>
  );
}

export function RenameTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [name, setName] = useState(task.title);
  const [suggestion, setSuggestion] = useState<TitleSuggestion | null>(null);
  const [suggestionError, setSuggestionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSuggestionError("");
    void api<TitleSuggestion>(`/tasks/${task.id}/title/suggest`, {
      method: "POST",
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSuggestion(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setSuggestionError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [task.id, attempt]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const updated = await post<Task>(`/tasks/${task.id}/title`, { title: name });
      // Merge only the title: a live turn may have changed status while this request was in flight.
      setShell({
        tasks: getShell().tasks.map((t) => (t.id === task.id ? { ...t, title: updated.title } : t)),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }
  return (
    <Dialog title="Rename task" onClose={onClose}>
      <form className="rename-task-form" onSubmit={(e) => void save(e)}>
        <label htmlFor="task-name">Name</label>
        <input
          ref={input}
          id="task-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_TASK_TITLE}
          autoComplete="off"
          required
        />
        <div className="task-name-suggestion" aria-live="polite" aria-busy={loading}>
          <div className="suggestion-heading">
            <span className={loading ? "activity-shimmer" : ""}>
              {loading ? "Suggesting a name…" : "Suggested from this conversation"}
            </span>
            {!loading && (
              <button
                type="button"
                className="icon-button"
                aria-label="Suggest another name"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw size={13} />
              </button>
            )}
          </div>
          {!loading && suggestionError ? (
            <span className="form-error">{suggestionError}</span>
          ) : (
            !loading &&
            suggestion && (
              <button
                type="button"
                className="suggested-task-name"
                onClick={() => {
                  setName(suggestion.title);
                  input.current?.focus();
                }}
                title="Use this name"
              >
                {suggestion.title}
              </button>
            )
          )}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
