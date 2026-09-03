import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  GitBranch,
  RefreshCw,
  X,
  Save,
  Pencil,
  Columns2,
  Rows3,
  LoaderCircle,
  FolderOpen,
  FileCode2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  WrapText,
  SlidersHorizontal,
  ChevronRight,
} from "lucide-react";
import type { GitStatusEntry } from "@pierre/trees";
import WorkspaceTree from "./WorkspaceTree";
import {
  workspaceSource,
  type WorkspaceSource,
  type FileData,
  type WorkspaceGit,
  type PreviewDiff,
} from "./workspace-source";
import type { PreviewSettings } from "./CodePreview";
import "./explorer.css";

const CodePreview = lazy(() => import("./CodePreview"));
const defaultSettings: PreviewSettings = {
  wrap: true,
  numbers: true,
  backgrounds: true,
  indicators: "bars",
  inline: "word-alt",
};

export default function Files({
  taskId,
  source: suppliedSource,
  workspaceName = "Workspace",
  onClose,
  initialTab = "files",
  initialPath,
  theme,
}: {
  taskId?: string;
  source?: WorkspaceSource;
  workspaceName?: string;
  onClose: () => void;
  initialTab?: "files" | "changes";
  initialPath?: string;
  theme: "light" | "dark";
}) {
  const source = useMemo(
    () => suppliedSource ?? workspaceSource(taskId!),
    [suppliedSource, taskId],
  );
  const [tab, setTab] = useState(initialTab);
  const [version, setVersion] = useState(0);
  const [treeVersion, setTreeVersion] = useState(0);
  const [git, setGit] = useState<WorkspaceGit | null>(null);
  const [opened, setOpened] = useState<FileData | null>(null);
  const [editing, setEditing] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [split, setSplit] = useState(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [patch, setPatch] = useState<(PreviewDiff & { path: string }) | null>(
    null,
  );
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selectionReset, setSelectionReset] = useState(0);
  const [width, setWidth] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [treeOverlay, setTreeOverlay] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState(300);
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const request = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const dirty = !!opened && editing !== opened.content;
  const preview = opened || patch;
  const activePath = loadingPath ?? preview?.path;
  const viewing = !!activePath;
  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setMeasuredWidth(Math.round(element.getBoundingClientRect().width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const changes = useMemo<GitStatusEntry[]>(
    () =>
      (git?.files ?? []).map(({ path, status }) => ({
        path,
        status:
          status === "??"
            ? "untracked"
            : status.includes("D")
              ? "deleted"
              : status.includes("R")
                ? "renamed"
                : status.includes("A")
                  ? "added"
                  : "modified",
      })),
    [git],
  );
  const diffStats = useMemo(() => {
    if (!patch) return null;
    if (patch.stats) return patch.stats;
    const lines = patch.content.split("\n");
    return {
      added: lines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++"),
      ).length,
      removed: lines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ).length,
    };
  }, [patch]);
  useEffect(
    () => () => {
      request.current?.abort();
      saveRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const abort = new AbortController();
    void source.git(abort.signal).then(
      (v) => {
        if (!abort.signal.aborted) setGit(v);
      },
      (e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => abort.abort();
  }, [source, version]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const discard = () => !dirty || confirm("Discard your unsaved changes?");
  async function open(path: string, diff = false) {
    if (saving || !discard()) return;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoadingPath(path);
    setTreeOverlay(false);
    setError("");
    try {
      if (diff) {
        const data = await source.diff(path, abort.signal);
        if (!abort.signal.aborted) {
          setPatch({ path, ...data });
          setOpened(null);
          setEditMode(false);
        }
      } else {
        const data = await source.file(path, abort.signal);
        if (!abort.signal.aborted) {
          setOpened(data);
          setEditing(data.content);
          setEditMode(false);
          setPatch(null);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        setSelectionReset((n) => n + 1);
      }
    } finally {
      if (!abort.signal.aborted) setLoadingPath(null);
    }
  }
  useEffect(() => {
    if (initialPath) void open(initialPath, initialTab === "changes");
  }, [source]);
  async function save() {
    if (!opened || saving) return;
    setSaving(true);
    const abort = new AbortController();
    saveRequest.current = abort;
    try {
      const data = await source.save(opened, editing, abort.signal);
      if (!abort.signal.aborted) {
        setOpened(data);
        setEditing(data.content);
        setEditMode(false);
        setVersion((v) => v + 1);
      }
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!abort.signal.aborted) setSaving(false);
    }
  }
  function back() {
    if (saving || !discard()) return;
    request.current?.abort();
    setLoadingPath(null);
    setOpened(null);
    setPatch(null);
    setEditMode(false);
    setSelectionReset((n) => n + 1);
    setWidth(undefined);
    setExpanded(false);
    setShowTree(true);
    setTreeOverlay(false);
    setError("");
  }
  function resize(next: number) {
    const available =
      pane.current?.parentElement?.clientWidth ?? window.innerWidth;
    setWidth(
      Math.max(
        viewing ? 420 : 260,
        Math.min(next, available - (available > 900 ? 300 : 0)),
      ),
    );
  }
  return (
    <aside
      ref={pane}
      aria-label="Workspace explorer"
      className={`files-pane ${viewing ? "preview" : ""} ${width ? "resized" : ""} ${expanded ? "expanded" : ""} ${resizing ? "resizing" : ""}`}
      style={
        {
          colorScheme: theme,
          ...(width && !expanded ? { "--explorer-width": `${width}px` } : {}),
        } as CSSProperties
      }
    >
      <div
        className="explorer-resize"
        role="separator"
        aria-label="Resize explorer"
        aria-orientation="vertical"
        aria-valuenow={measuredWidth}
        aria-valuetext={`${measuredWidth} pixels wide`}
        tabIndex={0}
        onPointerDown={(e) => {
          if (expanded) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            width: pane.current!.getBoundingClientRect().width,
          };
          setResizing(true);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            resize(drag.current.width + drag.current.x - e.clientX);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setResizing(false);
        }}
        onPointerUp={(e) => {
          drag.current = null;
          setResizing(false);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={() => setWidth(undefined)}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) {
            e.preventDefault();
            if (e.key === "Home") setWidth(undefined);
            else
              resize(
                (pane.current?.clientWidth ?? 300) +
                  (e.key === "ArrowLeft" ? 40 : -40),
              );
          }
        }}
      />
      <header className="explorer-header">
        <div className="panel-tabs" role="tablist" aria-label="Workspace view">
          <button
            role="tab"
            aria-selected={tab === "files"}
            className={tab === "files" ? "selected" : ""}
            onClick={() => {
              setTab("files");
              setShowTree(true);
              if (viewing && pane.current!.clientWidth <= 720) {
                setTreeOverlay(true);
                setSelectionReset((n) => n + 1);
              }
            }}
          >
            All files
          </button>
          <button
            role="tab"
            aria-selected={tab === "changes"}
            className={tab === "changes" ? "selected" : ""}
            onClick={() => {
              setTab("changes");
              setShowTree(true);
              if (viewing && pane.current!.clientWidth <= 720) {
                setTreeOverlay(true);
                setSelectionReset((n) => n + 1);
              }
            }}
          >
            Changes <small>{changes.length}</small>
          </button>
        </div>
        <button
          aria-label="Refresh workspace"
          title="Refresh workspace"
          className="icon-button"
          disabled={saving || dirty}
          onClick={() => {
            setVersion((v) => v + 1);
            setTreeVersion((v) => v + 1);
            if (preview) void open(preview.path, !!patch);
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button
          aria-label={expanded ? "Restore sidebar" : "Expand explorer"}
          title={expanded ? "Restore sidebar" : "Expand explorer"}
          className="icon-button"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          aria-label="Close files"
          className="icon-button"
          disabled={saving}
          onClick={() => {
            if (discard()) onClose();
          }}
        >
          <X size={15} />
        </button>
      </header>
      {error && (
        <div className="explorer-error" role="alert">
          {error}
          <button
            aria-label="Dismiss explorer error"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        className={`explorer-body ${viewing ? "has-viewer" : ""} ${showTree ? "" : "tree-hidden"} ${treeOverlay ? "mobile-tree" : ""}`}
      >
        <div className="explorer-navigation">
          <div className="workspace-caption">
            <FolderOpen size={14} />
            <span title={workspaceName}>{workspaceName}</span>
            {git?.branch && (
              <span className="workspace-branch" title={git.branch}>
                <GitBranch size={11} />
                {git.branch}
              </span>
            )}
            {treeOverlay && (
              <button
                className="return-to-preview"
                onClick={() => setTreeOverlay(false)}
              >
                <ChevronRight size={13} />
                Back to file
              </button>
            )}
          </div>
          <div className="file-list" hidden={tab !== "files"}>
            <WorkspaceTree
              key={treeVersion}
              source={source}
              changes={changes}
              resetSelection={selectionReset}
              activePath={treeOverlay ? undefined : activePath}
              theme={theme}
              onOpen={(path) => void open(path)}
            />
          </div>
          <div className="file-list" hidden={tab !== "changes"}>
            {changes.length ? (
              <WorkspaceTree
                source={source}
                changes={changes}
                changesOnly
                resetSelection={selectionReset}
                activePath={treeOverlay ? undefined : activePath}
                theme={theme}
                onOpen={(path) => void open(path, true)}
              />
            ) : (
              <div className="panel-empty">
                <GitBranch size={23} />
                <strong>
                  {!git
                    ? "Loading changes…"
                    : git.isGit
                      ? "All clear"
                      : "No Git repository"}
                </strong>
                <p>
                  {git?.isGit
                    ? "Your working tree is clean."
                    : git
                      ? "Initialize Git to track changes."
                      : ""}
                </p>
              </div>
            )}
          </div>
        </div>
        {viewing && (
          <section
            className="file-viewer"
            aria-label={patch ? "Diff viewer" : "File viewer"}
          >
            <header className="file-viewer-header">
              <FileCode2 size={15} />
              <nav
                className="file-breadcrumb"
                aria-label="File path"
                title={activePath}
              >
                {activePath?.split("/").map((part, i, parts) => (
                  <span
                    key={i}
                    className={i === parts.length - 1 ? "filename" : ""}
                  >
                    {i > 0 && <ChevronRight size={11} />}
                    {part}
                  </span>
                ))}
              </nav>
              {diffStats && (
                <span className="diff-stats">
                  <span className="removed">−{diffStats.removed}</span>
                  <span className="added">+{diffStats.added}</span>
                </span>
              )}
              {dirty && (
                <span className="unsaved-dot" title="Unsaved changes" />
              )}
              <button
                className="icon-button viewer-tree-desktop"
                aria-label={showTree ? "Hide file tree" : "Show file tree"}
                title={showTree ? "Hide file tree" : "Show file tree"}
                onClick={() => setShowTree((v) => !v)}
              >
                <PanelRightClose size={14} />
              </button>
              <button
                className="icon-button viewer-tree-mobile"
                aria-label="Show file tree"
                title="Show file tree"
                onClick={() => {
                  setTreeOverlay(true);
                  setShowTree(true);
                  setSelectionReset((n) => n + 1);
                }}
              >
                <FolderOpen size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Close preview"
                title="Close preview"
                disabled={saving}
                onClick={back}
              >
                <X size={15} />
              </button>
            </header>
            <div className="file-viewer-toolbar">
              {patch ? (
                <div
                  className="diff-layout"
                  role="group"
                  aria-label="Diff layout"
                >
                  <button
                    aria-pressed={!split}
                    onClick={() => {
                      setSplit(false);
                    }}
                  >
                    <Rows3 size={13} />
                    Unified
                  </button>
                  <button
                    aria-pressed={split}
                    onClick={() => {
                      setSplit(true);
                    }}
                  >
                    <Columns2 size={13} />
                    Split
                  </button>
                </div>
              ) : (
                <span className="file-viewer-kind">
                  {editMode ? "Editing" : "Preview"}
                </span>
              )}
              <div className="viewer-actions">
                {!editMode && (
                  <>
                    <button
                      className="icon-button"
                      aria-label="Wrap lines"
                      title="Wrap lines"
                      aria-pressed={settings.wrap}
                      onClick={() =>
                        setSettings((s) => ({ ...s, wrap: !s.wrap }))
                      }
                    >
                      <WrapText size={15} />
                    </button>
                    <details className="viewer-options">
                      <summary aria-label="View options" title="View options">
                        <SlidersHorizontal size={14} />
                      </summary>
                      <div className="viewer-options-menu">
                        <label>
                          <input
                            type="checkbox"
                            checked={settings.numbers}
                            onChange={(e) =>
                              setSettings((s) => ({
                                ...s,
                                numbers: e.target.checked,
                              }))
                            }
                          />
                          Line numbers
                        </label>
                        {patch && (
                          <>
                            <label>
                              <input
                                type="checkbox"
                                checked={settings.backgrounds}
                                onChange={(e) =>
                                  setSettings((s) => ({
                                    ...s,
                                    backgrounds: e.target.checked,
                                  }))
                                }
                              />
                              Line backgrounds
                            </label>
                            <label>
                              Indicators
                              <select
                                aria-label="Diff indicators"
                                value={settings.indicators}
                                onChange={(e) =>
                                  setSettings((s) => ({
                                    ...s,
                                    indicators: e.target
                                      .value as PreviewSettings["indicators"],
                                  }))
                                }
                              >
                                <option value="bars">Bars</option>
                                <option value="classic">Classic +/−</option>
                                <option value="none">None</option>
                              </select>
                            </label>
                            <label>
                              Highlight
                              <select
                                aria-label="Inline highlighting"
                                value={settings.inline}
                                onChange={(e) =>
                                  setSettings((s) => ({
                                    ...s,
                                    inline: e.target
                                      .value as PreviewSettings["inline"],
                                  }))
                                }
                              >
                                <option value="word-alt">Words</option>
                                <option value="char">Characters</option>
                                <option value="none">None</option>
                              </select>
                            </label>
                          </>
                        )}
                      </div>
                    </details>
                  </>
                )}
                {opened && (
                  <button
                    className="viewer-edit"
                    disabled={saving}
                    onClick={() => {
                      if (!editMode || discard()) {
                        setEditing(opened.content);
                        setEditMode(!editMode);
                      }
                    }}
                  >
                    <Pencil size={13} />
                    {editMode ? "Cancel" : "Edit file"}
                  </button>
                )}
                {editMode && (
                  <button
                    className="viewer-save"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                  >
                    <Save size={13} />
                    {saving ? "Saving…" : "Save file"}
                  </button>
                )}
              </div>
            </div>
            {loadingPath ? (
              <div className="preview-loading" role="status">
                <LoaderCircle size={16} className="spin" />
                Opening {loadingPath.split("/").at(-1)}…
              </div>
            ) : opened && editMode ? (
              <textarea
                aria-label="File contents"
                className="file-editor"
                spellCheck={false}
                value={editing}
                disabled={saving}
                onChange={(e) => setEditing(e.target.value)}
              />
            ) : (
              <Suspense
                fallback={
                  <div className="preview-loading">Loading preview…</div>
                }
              >
                <CodePreview
                  file={opened ?? undefined}
                  patch={patch ?? undefined}
                  theme={theme}
                  split={split}
                  settings={settings}
                />
              </Suspense>
            )}
            <footer className="viewer-footer">
              <span>
                {patch
                  ? "Working tree ↔ HEAD"
                  : dirty
                    ? "Unsaved changes"
                    : "UTF-8"}
              </span>
              <span>
                {opened
                  ? `${opened.content.split("\n").length - (opened.content.endsWith("\n") ? 1 : 0)} lines`
                  : split
                    ? "Side by side"
                    : "Unified diff"}
              </span>
            </footer>
          </section>
        )}
      </div>
    </aside>
  );
}
