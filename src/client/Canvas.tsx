import { useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { loadCanvas, saveCanvas } from "./canvas-storage";
import "@excalidraw/excalidraw/index.css";

export default function Canvas({
  persistenceKey,
  theme,
  active,
  registerGuard,
}: {
  persistenceKey: string;
  theme: "light" | "dark";
  active: boolean;
  registerGuard: (guard: (() => boolean) | null) => void;
}) {
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const scene = useRef<ExcalidrawInitialDataState>({});
  const signature = useRef("");
  const revision = useRef(0);
  const unsaved = useRef(false);

  useEffect(() => {
    registerGuard(() => !unsaved.current || window.confirm(
      "This canvas has unsaved changes. Close anyway? Cancel to wait for saving, retry, or export a copy.",
    ));
    return () => registerGuard(null);
  }, [registerGuard]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadCanvas(persistenceKey).then((data) => {
      if (cancelled) return;
      scene.current = data ?? {};
      setInitialData(data);
    }).catch(() => {
      if (!cancelled) setError("Could not load this canvas. Reload to retry; saved content has not been overwritten.");
    });
    return () => { cancelled = true; };
  }, [persistenceKey]);

  // Workspace navigation animates the parent with a transform. Refresh offsets
  // after the transition so pointer coordinates match the visible board.
  useEffect(() => {
    if (!active || !api) return;
    api.refresh();
    const timer = setTimeout(() => api.refresh(), 400);
    return () => clearTimeout(timer);
  }, [active, api]);

  function persist() {
    const current = ++revision.current;
    unsaved.current = true;
    setSaving(true);
    saveCanvas(persistenceKey, scene.current).then(() => {
      if (current !== revision.current) return;
      unsaved.current = false;
      setSaving(false);
      setError("");
    }).catch(() => {
      if (current !== revision.current) return;
      setSaving(false);
      setError("Canvas could not be saved. Keep it open and export a copy from the canvas menu.");
    });
  }

  const onChange: NonNullable<ExcalidrawProps["onChange"]> = (elements, appState, files) => {
    const savedState = {
      viewBackgroundColor: appState.viewBackgroundColor,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
      gridSize: appState.gridSize,
      gridModeEnabled: appState.gridModeEnabled,
    };
    const next = JSON.stringify([
      elements.map((element) => [element.id, element.version, element.versionNonce]),
      Object.keys(files), savedState,
    ]);
    if (next === signature.current) return;
    signature.current = next;
    scene.current = { ...scene.current, elements, files, appState: savedState };
    persist();
  };

  return (
    <div className="canvas-column">
      <div className="canvas-storage-note" role="status">
        {error || (initialData === undefined ? "Loading canvas…" : saving ? "Saving…" : "Saved in this browser")}
        {error && initialData !== undefined && (
          <button onClick={persist} disabled={saving}>Retry save</button>
        )}
      </div>
      <div className="canvas-editor">
        {initialData !== undefined && (
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={setApi}
            theme={theme}
            autoFocus={false}
            handleKeyboardGlobally={false}
            onChange={onChange}
            onLibraryChange={(libraryItems) => {
              scene.current = { ...scene.current, libraryItems };
              persist();
            }}
            UIOptions={{ canvasActions: { toggleTheme: false } }}
          />
        )}
      </div>
    </div>
  );
}
