import { useEffect, useState } from "react";
import { ChevronRight, File, Folder, GitBranch, RefreshCw, X, ArrowLeft, Save } from "lucide-react";
import { api, setShell } from "./state";

interface Entry {
  name: string;
  path: string;
  type: string;
}
interface FileData {
  path: string;
  content: string;
  revision: string;
}
interface GitStatus {
  isGit: boolean;
  branch: string | null;
  files: { path: string; status: string }[];
}
const failure = (e: unknown) => setShell({ error: e instanceof Error ? e.message : String(e) });
function Directory({
  taskId,
  path = "",
  depth = 0,
  onOpen,
}: {
  taskId: string;
  path?: string;
  depth?: number;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    void api<Entry[]>(`/tasks/${taskId}/tree?path=${encodeURIComponent(path)}`).then((v) => {
      if (active) setEntries(v);
    }, failure);
    return () => {
      active = false;
    };
  }, [taskId, path]);
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 14 + depth * 15 }}
            onClick={() => {
              if (e.type === "directory")
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(e.path)) next.delete(e.path);
                  else next.add(e.path);
                  return next;
                });
              else onOpen(e.path);
            }}
          >
            <ChevronRight
              size={12}
              className={`${e.type !== "directory" ? "invisible" : ""} ${open.has(e.path) ? "rotate" : ""}`}
            />
            {e.type === "directory" ? <Folder size={14} /> : <File size={14} />}
            <span>{e.name}</span>
          </button>
          {open.has(e.path) && (
            <Directory taskId={taskId} path={e.path} depth={depth + 1} onOpen={onOpen} />
          )}
        </div>
      ))}
    </>
  );
}
export default function Files({
  taskId,
  onClose,
  initialTab = "files",
}: {
  taskId: string;
  onClose: () => void;
  initialTab?: "files" | "changes";
}) {
  const [tab, setTab] = useState(initialTab);
  const [version, setVersion] = useState(0);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [opened, setOpened] = useState<FileData | null>(null);
  const [editing, setEditing] = useState("");
  const [patch, setPatch] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => {
    let active = true;
    void api<GitStatus>(`/tasks/${taskId}/git`).then((v) => {
      if (active) setGit(v);
    }, failure);
    return () => {
      active = false;
    };
  }, [taskId, version]);
  const open = async (path: string) => {
    try {
      const data = await api<FileData>(`/tasks/${taskId}/file?path=${encodeURIComponent(path)}`);
      setOpened(data);
      setEditing(data.content);
    } catch (e) {
      failure(e);
    }
  };
  const openDiff = async (path: string) => {
    try {
      const data = await api<{ content: string }>(
        `/tasks/${taskId}/diff?path=${encodeURIComponent(path)}`,
      );
      setPatch({ path, content: data.content });
    } catch (e) {
      failure(e);
    }
  };
  const save = async () => {
    if (!opened) return;
    try {
      const data = await api<FileData>(`/tasks/${taskId}/file`, {
        method: "PUT",
        body: JSON.stringify({ ...opened, content: editing }),
      });
      setOpened(data);
      setVersion((v) => v + 1);
    } catch (e) {
      failure(e);
    }
  };
  if (opened || patch)
    return (
      <aside className="files-pane preview">
        <header>
          <button
            className="icon-button"
            aria-label="Back to files"
            onClick={() => {
              if (opened && editing !== opened.content && !confirm("Discard your unsaved changes?"))
                return;
              setOpened(null);
              setPatch(null);
            }}
          >
            <ArrowLeft size={15} />
          </button>
          <span title={opened?.path ?? patch?.path}>{opened?.path ?? patch?.path}</span>
          {opened && (
            <button
              title="Save file"
              aria-label="Save file"
              disabled={editing === opened.content}
              className="icon-button"
              onClick={() => void save()}
            >
              <Save size={15} />
            </button>
          )}
        </header>
        {opened ? (
          <textarea
            aria-label="File contents"
            className="file-editor"
            spellCheck={false}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
          />
        ) : (
          <div className="diff-content">
            {patch?.content.split("\n").map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith("+")
                    ? "added"
                    : line.startsWith("-")
                      ? "removed"
                      : line.startsWith("@@")
                        ? "hunk"
                        : ""
                }
              >
                {line || " "}
              </div>
            ))}
          </div>
        )}
        <footer>
          {opened
            ? editing === opened.content
              ? "Saved · changes are written on the server"
              : "Unsaved changes"
            : "Working tree compared with HEAD"}
        </footer>
      </aside>
    );
  return (
    <aside className="files-pane">
      <header>
        <div className="panel-tabs">
          <button className={tab === "files" ? "selected" : ""} onClick={() => setTab("files")}>
            Files
          </button>
          <button className={tab === "changes" ? "selected" : ""} onClick={() => setTab("changes")}>
            Changes {git?.files.length ? <small>{git.files.length}</small> : null}
          </button>
        </div>
        <button
          aria-label="Refresh workspace"
          className="icon-button"
          onClick={() => setVersion((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <button aria-label="Close files" className="icon-button" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="file-list">
        {tab === "files" ? (
          <Directory key={version} taskId={taskId} onOpen={(path) => void open(path)} />
        ) : (
          <>
            <div className="branch-label">
              <GitBranch size={14} />
              {git?.branch ?? "No Git repository"}
            </div>
            {git?.files.length ? (
              git.files.map((f) => (
                <button className="changed-row" key={f.path} onClick={() => void openDiff(f.path)}>
                  <File size={14} />
                  <span>{f.path}</span>
                  <code className={f.status === "??" ? "new" : "modified"}>
                    {f.status === "??" ? "U" : f.status.trim()}
                  </code>
                </button>
              ))
            ) : (
              <div className="panel-empty">
                <GitBranch size={26} />
                <strong>{git?.isGit ? "All clear" : "No Git repository"}</strong>
                <p>
                  {git?.isGit
                    ? "Your working tree is clean."
                    : "Initialize Git in this workspace to track changes."}
                </p>
              </div>
            )}
          </>
        )}
      </div>
      <footer>Files on the server</footer>
    </aside>
  );
}
