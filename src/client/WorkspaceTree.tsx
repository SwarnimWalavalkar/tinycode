import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { LoaderCircle } from "lucide-react";
import type { WorkspaceSource } from "./workspace-source";

export default function WorkspaceTree({
  source,
  changes,
  changesOnly = false,
  onOpen,
  resetSelection,
  activePath,
  theme,
}: {
  source: WorkspaceSource;
  changes: GitStatusEntry[];
  changesOnly?: boolean;
  onOpen: (path: string) => void;
  resetSelection: number;
  activePath?: string;
  theme: "light" | "dark";
}) {
  const open = useRef(onOpen);
  useLayoutEffect(() => {
    open.current = onOpen;
  }, [onOpen]);
  const [loading, setLoading] = useState(!changesOnly);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const clearingSelection = useRef(false);
  const { model } = useFileTree({
    paths: changesOnly ? changes.map((entry) => entry.path) : [],
    initialExpansion: changesOnly ? "open" : "closed",
    flattenEmptyDirectories: true,
    density: "default",
    icons: { set: "complete", colored: true },
    gitStatus: changes,
    onSelectionChange(paths) {
      const path = paths.at(-1);
      if (!clearingSelection.current && path && !path.endsWith("/"))
        open.current(path);
    },
  });
  useEffect(() => {
    clearingSelection.current = true;
    for (const path of [...model.getSelectedPaths()])
      model.getItem(path)?.deselect();
    clearingSelection.current = false;
  }, [model, resetSelection]);
  useEffect(() => {
    if (changesOnly) {
      model.resetPaths(changes.map((entry) => entry.path));
    }
    model.setGitStatus(changes);
  }, [model, changes, changesOnly]);
  useEffect(() => {
    function selectActive(force = false) {
      if (!activePath || clearingSelection.current) return;
      if (!force && model.getSelectedPaths().length) return;
      const item = model.getItem(activePath);
      if (!item || item.isSelected()) return;
      clearingSelection.current = true;
      for (const path of model.getSelectedPaths())
        model.getItem(path)?.deselect();
      item.select();
      clearingSelection.current = false;
    }
    selectActive(true);
    return model.subscribe(() => selectActive());
  }, [model, activePath, changes]);
  useEffect(() => {
    if (changesOnly) return;
    const abort = new AbortController();
    const requested = new Set<string>();
    const directories = new Set<string>();
    let pending = 0;
    async function load(path: string) {
      if (requested.has(path)) return;
      requested.add(path);
      pending++;
      setLoading(true);
      try {
        const entries = await source.tree(path, abort.signal);
        if (abort.signal.aborted) return;
        if (!path) setEmpty(!entries.length);
        const paths = entries.map((entry) => {
          const path = entry.path + (entry.type === "directory" ? "/" : "");
          if (entry.type === "directory") directories.add(path);
          return path;
        });
        model.batch(paths.map((path) => ({ type: "add", path })));
      } catch (error) {
        if (!abort.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        pending--;
        if (!abort.signal.aborted) setLoading(pending > 0);
      }
    }
    const unsubscribe = model.subscribe(() => {
      for (const path of directories) {
        const item = model.getItem(path);
        if (item && "isExpanded" in item && item.isExpanded()) void load(path);
      }
    });
    void load("");
    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [source, model, changesOnly]);
  return (
    <div className="workspace-tree">
      {loading && (
        <div className="tree-note" role="status">
          <LoaderCircle size={12} className="spin" />
          Loading files…
        </div>
      )}
      {error && (
        <div className="tree-note" role="alert">
          {error}. Refresh to try again.
        </div>
      )}
      {empty && <div className="tree-note">This folder is empty.</div>}
      <FileTree
        model={model}
        className="pierre-tree"
        style={{ colorScheme: theme }}
        aria-label={changesOnly ? "Changed files" : "Workspace files"}
      />
    </div>
  );
}
