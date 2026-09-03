import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ImagePlus,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Search,
  Square,
  Sun,
  TerminalSquare,
  X,
  ShieldCheck,
  AlertCircle,
  ListEnd,
  CornerDownRight,
} from "lucide-react";
import type {
  Approval,
  DeliveryMode,
  Project,
  ProviderId,
  Task,
  QueuedMessage,
} from "../shared/contracts";
import { taskAttentionLabel } from "../shared/attention";
import {
  earlier,
  getShell,
  latest,
  markTaskRead,
  post,
  selectTask,
  setShell,
  useShell,
  useTimeline,
} from "./state";

import ModelPicker from "./ModelPicker";
import { defaultPermissionMode, type PermissionMode } from "../shared/permissions";
import Transcript from "./Transcript";
import MessageQueue from "./MessageQueue";
import { ImageShelf, useDraftImages } from "./Images";
import { IMAGE_TYPES } from "../shared/images";
import Dialog from "./Dialog";
import ConnectionDialog from "./ConnectionDialog";
import {
  checkConnection,
  connection,
  connectionLabel,
  isLocalServer,
  saveConnection,
  serverStorageKey,
} from "./connection";
import { TaskContextMenu, RenameTaskDialog, type TaskMenuPosition } from "./TaskNaming";
import { ProviderMark, providerNames } from "./Harness";

const Terminal = lazy(() => import("./Terminal"));
const Files = lazy(() => import("./Files"));

const welcomePhrases = [
  "What should we work on today?",
  "What should we build?",
  "What's on your mind?",
  "Where should we start?",
  "What are we making next?",
  "What are we building?",
  "What are you thinking about?",
  "Ready when you are.",
  "What problem are we chasing?",
  "What are you curious about?",
  "What should we learn together?",
  "What are you trying to understand?",
];

const fail = (error: unknown) =>
  setShell({ error: error instanceof Error ? error.message : String(error) });

function savedSelection(): { provider: ProviderId; model: string; thinkingLevel: string | null } {
  try {
    const value = JSON.parse(
      localStorage.getItem(serverStorageKey("tinycode-selection")) ?? "null",
    );
    if (
      value &&
      ["codex", "claude", "pi"].includes(value.provider) &&
      typeof value.model === "string" &&
      value.model.length <= 200
    )
      return {
        ...value,
        thinkingLevel:
          typeof value.thinkingLevel === "string" && value.thinkingLevel.length <= 32
            ? value.thinkingLevel
            : null,
      };
  } catch {}
  return { provider: "codex", model: "", thinkingLevel: null };
}

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span aria-hidden="true" className={`mark ${small ? "small" : ""}`}>
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function Status({ status }: { status: Task["status"] }) {
  return status === "running" ? (
    <LoaderCircle className="spin" size={13} />
  ) : status === "waiting" ? (
    <Circle className="waiting" fill="currentColor" size={7} />
  ) : status === "complete" ? (
    <Check size={13} />
  ) : status === "failed" ? (
    <AlertCircle size={13} />
  ) : (
    <Circle size={8} />
  );
}

function ProjectDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (p: Project) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await post<Project>("/projects", { path });
      onAdd(p);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Open a project" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <p>Choose a folder on the machine running Tinycode.</p>
        <label htmlFor="project-path">Project path</label>
        <input
          id="project-path"
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/projects/my-app"
          autoComplete="off"
          spellCheck={false}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !path.trim()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}Open
            project
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function SearchDialog({ onClose }: { onClose: () => void }) {
  const { tasks, projects } = useShell();
  const [query, setQuery] = useState("");
  const found = tasks.filter((t) =>
    `${t.title} ${providerNames[t.provider]} ${projects.find((p) => p.id === t.projectId)?.name ?? "No project"}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Dialog title="Jump to a task" onClose={onClose}>
      <div className="search-input">
        <Search size={17} />
        <input
          autoFocus
          aria-label="Search tasks"
          placeholder="Search your tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>esc</kbd>
      </div>
      <div className="search-results">
        {found.length ? (
          found.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                selectTask(t.id);
                onClose();
              }}
            >
              <ProviderMark id={t.provider} />
              <span>
                {t.title}
                <small>{projects.find((p) => p.id === t.projectId)?.name ?? "No project"}</small>
              </span>
              <ArrowUpRight size={15} />
            </button>
          ))
        ) : (
          <p>No tasks found.</p>
        )}
      </div>
    </Dialog>
  );
}

const Composer = memo(function Composer({
  task,
  onCreate,
  disabled = false,
  controls,
  canSteer = false,
  queue = [],
}: {
  task?: Task;
  onCreate?: (text: string, images: string[]) => Promise<void>;
  disabled?: boolean;
  controls?: ReactNode;
  canSteer?: boolean;
  queue?: QueuedMessage[];
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<DeliveryMode>(() => {
    try {
      return localStorage.getItem("tinycode.deliveryMode") === "steer" ? "steer" : "queue";
    } catch {
      return "queue";
    }
  });
  const normalDraft = useDraftImages();
  const editDraft = useDraftImages();
  const [editing, setEditing] = useState<QueuedMessage | null>(null);
  const previousText = useRef("");
  const draft = editing ? editDraft : normalDraft;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = task?.status === "running" || task?.status === "waiting";
  useLayoutEffect(() => {
    if (!editing || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [editing?.id]);
  const queuedEdit = editing && queue.find((message) => message.id === editing.id);
  const editProblem =
    editing &&
    (!queuedEdit || queuedEdit.status === "sending"
      ? "This message has left the queue. Your edits have not been sent."
      : queuedEdit.text !== editing.text ||
          JSON.stringify(queuedEdit.images ?? []) !== JSON.stringify(editing.images ?? [])
        ? "This message changed elsewhere. Cancel and reopen it to edit the latest version."
        : null);
  function finishEditing() {
    editDraft.replace([]);
    setText(previousText.current);
    setEditing(null);
    input.current?.focus();
  }
  async function send() {
    if (
      (!text.trim() && !draft.images.length) ||
      !draft.ready ||
      sending ||
      disabled ||
      editProblem
    )
      return;
    setSending(true);
    const prompt = text;
    const images = draft.images.map((image) => image.id);
    const key = JSON.stringify([prompt, images]);
    try {
      if (task && editing) {
        await post(`/tasks/${task.id}/queue/edit`, {
          id: editing.id,
          text: prompt,
          images,
          expectedText: editing.text,
          expectedImages: (editing.images ?? []).map((image) => image.id),
        });
        finishEditing();
        return;
      }
      if (task) {
        const delivery = busy && canSteer ? mode : "queue";
        if (!attempt.current || attempt.current.key !== key)
          attempt.current = { key, id: crypto.randomUUID() };
        await post(`/tasks/${task.id}/send`, {
          text: prompt,
          images,
          mode: delivery,
          requestId: attempt.current.id,
        });
        attempt.current = null;
        latest();
      } else await onCreate?.(prompt, images);
      draft.clear(images);
      setText((current) => (current === prompt ? "" : current));
    } catch (error) {
      fail(error);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }
  return (
    <>
      {task && (
        <MessageQueue
          taskId={task.id}
          messages={queue}
          busy={busy}
          canSteer={canSteer}
          disabled={disabled || sending}
          editingId={editing?.id ?? null}
          onEdit={(message) => {
            previousText.current = text;
            setText(message.text);
            editDraft.replace(message.images ?? []);
            setEditing(message);
          }}
        />
      )}
      <div
        className={`composer-stack ${dragging ? "dragging" : ""}`}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files") || disabled || sending) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = disabled || sending ? "none" : "copy";
          }
        }}
        onDragLeave={(e) => {
          if (e.dataTransfer.types.includes("Files") && --dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!disabled && !sending) draft.add(Array.from(e.dataTransfer.files));
          input.current?.focus();
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!files.length) return;
          e.preventDefault();
          if (!disabled && !sending) draft.add(files);
        }}
      >
        <ImageShelf draft={draft} disabled={sending} />
        <div className={`composer ${disabled ? "disabled" : ""}`}>
          {editing && (
            <div className="composer-editing">
              <span>Editing queued message</span>
              <button disabled={sending} onClick={finishEditing}>
                Cancel
              </button>
            </div>
          )}
          {dragging && (
            <div className="image-drop-hint">
              <ImagePlus size={22} />
              <span>Drop images here</span>
            </div>
          )}
          <input
            ref={fileInput}
            className="image-file-input"
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            aria-label="Choose images"
            onChange={(e) => {
              draft.add(Array.from(e.target.files ?? []));
              e.target.value = "";
              input.current?.focus();
            }}
          />

          <textarea
            ref={input}
            aria-label={task ? "Message your agent" : "Describe your task"}
            placeholder={
              task
                ? `Continue with ${providerNames[task.provider]}…`
                : "Ask anything, or describe a task"
            }
            value={text}
            readOnly={sending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && editing && !sending) {
                e.preventDefault();
                finishEditing();
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
          />
          <div className="composer-bottom">
            <button
              className="attach-image-button"
              aria-label="Attach images"
              title="Attach images"
              disabled={disabled || sending}
              onClick={() => fileInput.current?.click()}
            >
              <Plus size={17} />
            </button>
            {controls ?? (
              <span>
                {busy ? (
                  <>
                    <span className="activity-dot" />
                    {task?.status === "waiting" ? "Waiting for you" : "Working on your task"}
                  </>
                ) : (
                  <>
                    <MessageSquare size={13} />
                    <span>Shift + Enter for a new line</span>
                  </>
                )}
              </span>
            )}
            <div className="composer-actions">
              {busy && !editing && (
                <label
                  className="delivery-picker"
                  title={
                    mode === "steer" && canSteer
                      ? "Send into the current turn"
                      : "Send after this turn finishes"
                  }
                >
                  {mode === "steer" && canSteer ? (
                    <CornerDownRight size={13} />
                  ) : (
                    <ListEnd size={13} />
                  )}
                  <select
                    aria-label="Message delivery"
                    value={canSteer ? mode : "queue"}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = event.target.value as DeliveryMode;
                      setMode(value);
                      try {
                        localStorage.setItem("tinycode.deliveryMode", value);
                      } catch {}
                    }}
                  >
                    <option value="queue">Queue</option>
                    {canSteer && <option value="steer">Steer</option>}
                  </select>
                </label>
              )}
              {busy && (
                <button
                  className="send-button stop"
                  title="Stop task"
                  aria-label="Stop task"
                  disabled={disabled}
                  onClick={() => {
                    if (task) void post(`/tasks/${task.id}/interrupt`).catch(fail);
                  }}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              )}
              {(editing || !busy || text.trim() || draft.images.length > 0) && (
                <button
                  className="send-button"
                  disabled={
                    (!text.trim() && !draft.images.length) ||
                    !draft.ready ||
                    sending ||
                    disabled ||
                    !!editProblem
                  }
                  title={
                    editing
                      ? "Save queued message"
                      : busy
                        ? mode === "steer" && canSteer
                          ? "Steer message"
                          : "Queue message"
                        : "Send message"
                  }
                  aria-label={
                    editing
                      ? "Save queued message"
                      : busy
                        ? mode === "steer" && canSteer
                          ? "Steer message"
                          : "Queue message"
                        : "Send message"
                  }
                  onClick={() => void send()}
                >
                  {sending ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : editing ? (
                    <Check size={17} />
                  ) : (
                    <ArrowUp size={18} />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
        {draft.error && (
          <div className="attachment-error" role="alert">
            {draft.error}
          </div>
        )}
        {editProblem && (
          <div className="attachment-error" role="status">
            {editProblem}
          </div>
        )}
      </div>
    </>
  );
});

function ApprovalCard({ approval }: { approval: Approval }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  async function respond(allow: boolean) {
    setBusy(true);
    try {
      await post(`/tasks/${approval.taskId}/answer`, { id: approval.id, allow, text: answer });
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }
  return (
    <div className="approval-card">
      <div>
        <ShieldCheck size={17} />
        <strong>{approval.title}</strong>
      </div>
      <details>
        <summary>View request</summary>
        <pre>{approval.detail}</pre>
      </details>
      {approval.input && (
        <textarea
          aria-label="Your answer"
          placeholder="Your answer…"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      )}
      <footer>
        <button className="button secondary" disabled={busy} onClick={() => void respond(false)}>
          Decline
        </button>
        <button className="button primary" disabled={busy} onClick={() => void respond(true)}>
          {approval.input ? "Send answer" : "Allow once"}
        </button>
      </footer>
    </div>
  );
}
function Conversation({ task, connected }: { task: Task; connected: boolean }) {
  const timeline = useTimeline();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const sticky = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    if (
      !task.attentionId ||
      !connected ||
      !timeline.ready ||
      timeline.taskId !== task.id ||
      timeline.history ||
      away
    )
      return;
    const attentionId = task.attentionId;
    const markViewed = () => {
      if (document.visibilityState === "visible" && document.hasFocus())
        markTaskRead(task.id, attentionId);
    };
    markViewed();
    document.addEventListener("visibilitychange", markViewed);
    window.addEventListener("focus", markViewed);
    return () => {
      document.removeEventListener("visibilitychange", markViewed);
      window.removeEventListener("focus", markViewed);
    };
  }, [
    task.id,
    task.attentionId,
    connected,
    timeline.ready,
    timeline.taskId,
    timeline.history,
    away,
  ]);
  useEffect(() => {
    if (!content.current || !viewport.current) return;
    const observer = new ResizeObserver(() => {
      if (sticky.current && !timeline.history)
        viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
      else if (viewport.current)
        setAway(
          viewport.current.scrollHeight -
            viewport.current.scrollTop -
            viewport.current.clientHeight >=
            90,
        );
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [timeline.history]);
  useEffect(() => {
    sticky.current = true;
    setAway(false);
  }, [task.id]);
  return (
    <>
      <div
        ref={viewport}
        className="conversation-scroll"
        onScroll={() => {
          const el = viewport.current;
          if (el) {
            sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            setAway(!sticky.current);
          }
        }}
      >
        <div
          className="conversation"
          ref={content}
          onClickCapture={(event) => {
            if ((event.target as Element).closest("summary")) {
              sticky.current = false;
            }
          }}
        >
          {timeline.hasOlder && (
            <button
              className="history-button"
              onClick={() => {
                sticky.current = false;
                void earlier()
                  .then(() => viewport.current?.scrollTo({ top: 0 }))
                  .catch(fail);
              }}
            >
              Load earlier messages
            </button>
          )}
          {timeline.history && (
            <button
              className="history-button"
              onClick={() => {
                sticky.current = true;
                latest();
              }}
            >
              Back to latest
            </button>
          )}
          {timeline.ids.length ? (
            <Transcript task={task} />
          ) : (
            <div className="empty-conversation">
              <Mark />
              <h2>A fresh start.</h2>
              <p>Give {providerNames[task.provider]} something to work on.</p>
            </div>
          )}
        </div>
      </div>
      <div className="conversation-composer">
        {away && !timeline.history && (
          <button
            className="jump-latest"
            onClick={() => {
              sticky.current = true;
              viewport.current?.scrollTo({
                top: viewport.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            Jump to latest <ChevronDown size={13} />
          </button>
        )}
        {timeline.approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        <Composer
          key={task.id}
          task={task}
          queue={timeline.queue}
          canSteer={getShell().providers.some(
            (p) => p.id === task.provider && p.capabilities.steer,
          )}
          disabled={!connected}
          controls={
            <ModelPicker
              provider={task.provider}
              model={task.model}
              resolvedModel={task.resolvedModel}
              thinkingLevel={task.thinkingLevel}
              permissionMode={task.permissionMode}
              onPermissionsChange={async (permissionMode) => {
                await post(`/tasks/${task.id}/permissions`, { permissionMode });
              }}
              onThinkingChange={async (thinkingLevel) => {
                await post(`/tasks/${task.id}/thinking`, { thinkingLevel });
              }}
              taskId={task.id}
              disabled={!connected || task.status === "running" || task.status === "waiting"}
              onChange={async (_, model) => {
                await post(`/tasks/${task.id}/model`, { model });
              }}
            />
          }
        />
        <div className="composer-caption">
          <span>Shift + Enter for a new line</span>
          <span title={task.cwd}>
            {task.projectId === null ? <Folder size={12} /> : <GitBranch size={12} />}
            {task.projectId === null
              ? "Task workspace"
              : task.worktreePath
                ? "Worktree"
                : "Current checkout"}
          </span>
        </div>
      </div>
    </>
  );
}

function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function login(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      await checkConnection(connection, token.trim(), controller.signal);
      if (!controller.signal.aborted) saveConnection(connection, token.trim());
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    }
  }
  return (
    <div className="login">
      <Mark />
      <h1>Your workspace is here.</h1>
      <p>Enter the access token for {connectionLabel()}.</p>
      <form onSubmit={(e) => void login(e)}>
        <input
          type="password"
          aria-label="Access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
          placeholder="Server access token"
          disabled={busy}
        />
        <button className="button primary" disabled={busy}>
          {busy ? "Checking…" : "Connect"} <ArrowUpRight size={16} />
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <button
        className="button"
        onClick={() => {
          request.current?.abort();
          setBusy(false);
          setSettings(true);
        }}
      >
        Change server
      </button>
      {settings && <ConnectionDialog onClose={() => setSettings(false)} />}
    </div>
  );
}

function TaskButton({
  task,
  active,
  onOpen,
  onMenu,
}: {
  task: Task;
  active: boolean;
  onOpen: () => void;
  onMenu: (position: TaskMenuPosition) => void;
}) {
  const attention = taskAttentionLabel(task);
  return (
    <button
      className={`task-row ${task.projectId === null ? "projectless" : ""} ${active ? "active" : ""}`}
      onClick={onOpen}
      aria-haspopup="menu"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ task, x: e.clientX, y: e.clientY, trigger: e.currentTarget });
      }}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          onMenu({ task, x: bounds.left + 16, y: bounds.bottom, trigger: e.currentTarget });
        }
      }}
      title={`${task.title} · ${providerNames[task.provider]} · ${task.status}`}
    >
      <span className="task-title">{task.title}</span>
      {task.worktreePath && <GitBranch size={11} className="muted" />}
      {task.status === "running" ? (
        <LoaderCircle size={12} className="task-spinner spin" role="img" aria-label="In progress" />
      ) : attention ? (
        <span className="attention-dot" role="img" aria-label={attention} title={attention} />
      ) : null}
    </button>
  );
}

export function App() {
  const shell = useShell();
  const createAttempt = useRef<{ key: string; task: Task; requestId: string } | null>(null);
  const [welcomeIndex, setWelcomeIndex] = useState(0);
  const task = shell.tasks.find((t) => t.id === shell.activeTaskId);
  const [selectedProject, setSelectedProject] = useState(
    () => localStorage.getItem(serverStorageKey("tinycode-project")) ?? "",
  );
  const [provider, setProvider] = useState<ProviderId>(() => savedSelection().provider);
  const [model, setModel] = useState(() => savedSelection().model);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => defaultPermissionMode[savedSelection().provider],
  );
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(
    () => savedSelection().thinkingLevel,
  );
  const [branch, setBranch] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [options, setOptions] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const [connectionDialog, setConnectionDialog] = useState(false);
  const [search, setSearch] = useState(false);
  const [taskMenu, setTaskMenu] = useState<TaskMenuPosition | null>(null);
  const [renaming, setRenaming] = useState<TaskMenuPosition | null>(null);
  const [sidebar, setSidebar] = useState(() => window.matchMedia("(min-width: 621px)").matches);
  const [files, setFiles] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("tinycode-theme") === "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("tinycode-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    if (shell.loaded && selectedProject && !shell.projects.some((p) => p.id === selectedProject))
      setSelectedProject("");
  }, [selectedProject, shell.projects, shell.loaded]);
  useEffect(() => {
    localStorage.setItem(
      serverStorageKey("tinycode-selection"),
      JSON.stringify({ provider, model, thinkingLevel }),
    );
  }, [provider, model, thinkingLevel]);
  useEffect(() => {
    localStorage.setItem(serverStorageKey("tinycode-project"), selectedProject);
  }, [selectedProject]);
  useEffect(() => {
    if (shell.providers.length && !shell.providers.find((p) => p.id === provider)?.available) {
      const available = shell.providers.find((p) => p.available);
      if (available) {
        setProvider(available.id);
        setPermissionMode(defaultPermissionMode[available.id]);
        setModel("");
        setThinkingLevel(null);
      }
    }
  }, [shell.providers, provider]);
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        if (getShell().activeTaskId) setTerminal((s) => !s);
      }
      if (e.key === "Escape") setShell({ error: null });
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const project = shell.projects.find((p) => p.id === (task ? task.projectId : selectedProject));
  const projectlessTasks = shell.tasks.filter((t) => t.projectId === null);
  const available = shell.providers.find((p) => p.id === provider)?.available;
  async function create(text: string, images: string[]) {
    const useWorktree = project?.isGit && worktree;
    if (useWorktree && !branch.trim()) throw new Error("Name the branch for your new worktree");
    const key = JSON.stringify([
      text,
      images,
      project?.id,
      provider,
      model,
      thinkingLevel,
      permissionMode,
      useWorktree,
      branch,
    ]);
    if (createAttempt.current?.key !== key) createAttempt.current = null;
    if (!createAttempt.current) {
      const newTask = await post<Task>("/tasks", {
        projectId: project?.id ?? null,
        provider,
        model: model.trim() || undefined,
        thinkingLevel,
        permissionMode,
        branch: useWorktree ? branch.trim() : undefined,
      });
      createAttempt.current = { key, task: newTask, requestId: crypto.randomUUID() };
    }
    const attempt = createAttempt.current;
    await post(`/tasks/${attempt.task.id}/send`, { text, images, requestId: attempt.requestId });
    selectTask(attempt.task.id);
    createAttempt.current = null;
  }
  function chooseProject(projectId: string) {
    setSelectedProject(projectId);
    setBranch("");
    setWorktree(false);
  }
  function newTask(projectId = "") {
    createAttempt.current = null;
    setPermissionMode(defaultPermissionMode[provider]);
    setWelcomeIndex((index) => (index + 1) % welcomePhrases.length);
    selectTask(null);
    chooseProject(projectId);
    setOptions(false);
  }
  if (shell.authRequired) return <Login />;
  return (
    <div className={`app ${sidebar ? "" : "sidebar-hidden"}`}>
      {sidebar && (
        <aside className="sidebar">
          <div className="brand">
            <button className="brand-home" onClick={() => newTask()} aria-label="Tinycode home">
              <Mark small />
              <strong>tinycode</strong>
              <span>alpha</span>
            </button>
            <button
              className="icon-button subtle"
              aria-label="Hide sidebar"
              onClick={() => setSidebar(false)}
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <div className="sidebar-actions">
            <button className="new-task-button" onClick={() => newTask()}>
              <Plus size={17} /> New task <kbd>＋</kbd>
            </button>
          </div>
          <nav className="project-list" aria-label="Projects and tasks">
            {projectlessTasks.length > 0 && (
              <div className="project-group">
                <div className="section-label">
                  <span>SCRATCHPAD</span>
                  <button
                    aria-label="New scratchpad task"
                    title="New scratchpad task"
                    className="icon-button"
                    onClick={() => newTask()}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {projectlessTasks.map((t) => (
                  <TaskButton
                    key={t.id}
                    task={t}
                    onMenu={setTaskMenu}
                    active={t.id === task?.id}
                    onOpen={() => {
                      selectTask(t.id);
                      chooseProject("");
                    }}
                  />
                ))}
              </div>
            )}
            <div className="section-label">
              <span>PROJECTS</span>
              <button
                aria-label="Open a project"
                title="Open a project"
                className="icon-button"
                onClick={() => setProjectDialog(true)}
              >
                <Plus size={14} />
              </button>
            </div>
            {shell.projects.map((p) => (
              <div className="project-group" key={p.id}>
                <div className="project-heading">
                  <button title={p.path} onClick={() => newTask(p.id)}>
                    <ChevronDown size={12} />
                    <Folder size={15} />
                    <span>{p.name}</span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`New task in ${p.name}`}
                    onClick={() => newTask(p.id)}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {shell.tasks
                  .filter((t) => t.projectId === p.id)
                  .map((t) => (
                    <TaskButton
                      key={t.id}
                      task={t}
                      onMenu={setTaskMenu}
                      active={t.id === task?.id}
                      onOpen={() => {
                        selectTask(t.id);
                        chooseProject(p.id);
                      }}
                    />
                  ))}
                {!shell.tasks.some((t) => t.projectId === p.id) && (
                  <p className="no-tasks">A clean slate.</p>
                )}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="host-row">
              <button
                className="host-connection"
                onClick={() => setConnectionDialog(true)}
                aria-label="Server connection"
                title={connection.url}
                aria-haspopup="dialog"
              >
                {isLocalServer() ? <Monitor size={15} /> : <Globe2 size={15} />}
                <div>
                  <strong>{connectionLabel()}</strong>
                  <span role="status">
                    <i className={shell.connected ? "online" : "offline"} />
                    {shell.connected ? "Connected" : shell.loaded ? "Disconnected" : "Connecting…"}
                  </span>
                </div>
              </button>
              <button
                aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
                className="icon-button"
                onClick={() => setDark((d) => !d)}
              >
                {dark ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            </div>
          </div>
        </aside>
      )}
      <main className="main">
        <header className={`topbar ${task ? "" : "new-task"}`}>
          <div className="breadcrumb">
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="Show sidebar"
                onClick={() => setSidebar(true)}
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            <span>{project?.name ?? "Scratchpad"}</span>
            <ChevronRight size={13} />
            <strong>{task?.title ?? "New task"}</strong>
          </div>
          <div className="topbar-actions">
            {task && (
              <>
                <span className={`task-state ${task.status}`}>
                  <Status status={task.status} />
                  {task.status}
                </span>
                <span className="divider" />
                <button
                  className={`icon-button ${terminal ? "pressed" : ""}`}
                  title="Toggle terminal · ⌘J"
                  aria-label="Toggle terminal"
                  onClick={() => setTerminal((v) => !v)}
                >
                  <TerminalSquare size={17} />
                </button>
                <button
                  className={`icon-button ${files ? "pressed" : ""}`}
                  title="Files and changes"
                  aria-label="Toggle files"
                  onClick={() => setFiles((v) => !v)}
                >
                  <PanelRight size={17} />
                </button>
              </>
            )}
          </div>
        </header>
        <div className="work-area">
          <div className="center-pane">
            <div className="task-pane">
              {task ? (
                <Conversation task={task} connected={shell.connected} />
              ) : (
                <div className="welcome">
                  <div className="welcome-prompt">
                    <h1>{welcomePhrases[welcomeIndex]}</h1>
                  </div>
                  <div className="welcome-dock">
                    <div className="workspace-controls">
                      <button
                        className="workspace-selector"
                        aria-expanded={options}
                        onClick={() => setOptions((o) => !o)}
                      >
                        <Folder size={14} />
                        {project?.name ?? "No project"}
                        <ChevronDown size={12} />
                      </button>
                      {project?.isGit && (
                        <>
                          <span className="controls-dot">/</span>
                          <button
                            className="workspace-selector"
                            onClick={() => setOptions((o) => !o)}
                          >
                            <GitBranch size={13} />
                            {worktree ? "New worktree" : "Current checkout"}
                            <ChevronDown size={12} />
                          </button>
                        </>
                      )}
                    </div>
                    {options && (
                      <div className="task-options">
                        <label>
                          Project
                          <select
                            aria-label="Project"
                            value={selectedProject}
                            onChange={(e) => chooseProject(e.target.value)}
                          >
                            <option value="">No project</option>
                            {shell.projects.map((p) => (
                              <option value={p.id} key={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {project?.isGit && (
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={worktree}
                              onChange={(e) => setWorktree(e.target.checked)}
                            />
                            Start in a new worktree
                          </label>
                        )}
                        {project?.isGit && worktree && (
                          <label>
                            New branch
                            <input
                              aria-label="New branch"
                              value={branch}
                              onChange={(e) => setBranch(e.target.value)}
                              placeholder="feature/my-idea"
                            />
                          </label>
                        )}
                      </div>
                    )}
                    <Composer
                      onCreate={create}
                      disabled={!shell.connected || !available || !model}
                      controls={
                        <ModelPicker
                          provider={provider}
                          model={model}
                          thinkingLevel={thinkingLevel}
                          permissionMode={permissionMode}
                          onPermissionsChange={setPermissionMode}
                          disabled={!shell.connected}
                          onThinkingChange={setThinkingLevel}
                          projectId={project?.id}
                          onChange={(id, model) => {
                            if (id !== provider) setPermissionMode(defaultPermissionMode[id]);
                            setProvider(id);
                            setModel(model);
                            setThinkingLevel(null);
                          }}
                        />
                      }
                    />
                  </div>
                </div>
              )}
            </div>
            {task && terminal && (
              <Suspense fallback={<div className="panel-loading">Opening terminal…</div>}>
                <Terminal
                  key={task.id}
                  taskId={task.id}
                  connected={shell.connected}
                  onHide={() => setTerminal(false)}
                />
              </Suspense>
            )}
          </div>
          {task && files && (
            <Suspense fallback={<div className="panel-loading">Opening files…</div>}>
              <Files key={task.id} taskId={task.id} onClose={() => setFiles(false)} />
            </Suspense>
          )}
        </div>
      </main>
      {shell.error && !shell.authRequired && (
        <div className="toast" role="alert">
          <AlertCircle size={17} />
          <span>{shell.error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => setShell({ error: null })}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {projectDialog && (
        <ProjectDialog onClose={() => setProjectDialog(false)} onAdd={(p) => newTask(p.id)} />
      )}{" "}
      {connectionDialog && <ConnectionDialog onClose={() => setConnectionDialog(false)} />}
      {taskMenu && (
        <TaskContextMenu
          position={taskMenu}
          onClose={() => {
            taskMenu.trigger.focus();
            setTaskMenu(null);
          }}
          onRename={() => {
            setRenaming(taskMenu);
            setTaskMenu(null);
          }}
        />
      )}
      {renaming && (
        <RenameTaskDialog
          task={renaming.task}
          onClose={() => {
            const trigger = renaming.trigger;
            setRenaming(null);
            requestAnimationFrame(() => trigger.focus());
          }}
        />
      )}
      {search && <SearchDialog onClose={() => setSearch(false)} />}
    </div>
  );
}
