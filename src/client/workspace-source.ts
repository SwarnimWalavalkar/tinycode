import type { WorkspaceDiff, WorkspaceEntry } from "../shared/contracts";
import { api } from "./state";

export interface FileData {
  path: string;
  content: string;
  revision: string;
}
export interface WorkspaceGit {
  isGit: boolean;
  branch: string | null;
  files: { path: string; status: string }[];
}
export interface PreviewDiff extends WorkspaceDiff {
  /** Full contents let sample workspaces expand unchanged context without a server. */
  oldFile?: { name: string; contents: string } | null;
  stats?: { added: number; removed: number };
}
/** The explorer uses the same views for a connected workspace and its sample page. */
export interface WorkspaceSource {
  tree(path: string, signal: AbortSignal): Promise<WorkspaceEntry[]>;
  file(path: string, signal: AbortSignal): Promise<FileData>;
  diff(path: string, signal: AbortSignal): Promise<PreviewDiff>;
  git(signal: AbortSignal): Promise<WorkspaceGit>;
  save(file: FileData, content: string, signal: AbortSignal): Promise<FileData>;
}
export function workspaceSource(taskId: string): WorkspaceSource {
  const root = `/tasks/${taskId}`;
  return {
    tree: (path, signal) =>
      api(`${root}/tree?path=${encodeURIComponent(path)}`, { signal }),
    file: (path, signal) =>
      api(`${root}/file?path=${encodeURIComponent(path)}`, { signal }),
    diff: (path, signal) =>
      api(`${root}/diff?path=${encodeURIComponent(path)}`, { signal }),
    git: (signal) => api(`${root}/git`, { signal }),
    save: (file, content, signal) =>
      api(`${root}/file`, {
        method: "PUT",
        body: JSON.stringify({ ...file, content }),
        signal,
      }),
  };
}
