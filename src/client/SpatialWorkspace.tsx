import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Plus,
  X,
  Keyboard,
  Grid2X2,
  Columns2,
} from "lucide-react";
import type { Task } from "../shared/contracts";
import { serverStorageKey } from "./connection";
import {
  initialSpatial,
  moveSpatial,
  removeSpatial,
  restoreSpatial,
  type SpatialPanel,
} from "./spatial-state";
import "./spatial.css";
const Canvas = lazy(() => import("./Canvas"));
const Files = lazy(() => import("./Files"));
const Terminal = lazy(() => import("./Terminal"));
const CloudShell = lazy(() => import("./CloudShell"));
const directions = [
  { key: "ArrowLeft", dx: -1, dy: 0, name: "Left", Icon: ArrowLeft },
  { key: "ArrowUp", dx: 0, dy: -1, name: "Up", Icon: ArrowUp },
  { key: "ArrowDown", dx: 0, dy: 1, name: "Down", Icon: ArrowDown },
  { key: "ArrowRight", dx: 1, dy: 0, name: "Right", Icon: ArrowRight },
];
const options = [
  { kind: "files", label: "Files" },
  { kind: "changes", label: "Changes" },
  { kind: "terminal", label: "Terminal" },
  { kind: "chat", label: "Main chat" },
  { kind: "canvas", label: "New canvas" },
] as const;
export default function SpatialWorkspace({
  task,
  connected,
  theme,
  children,
  workspaceName,
  onVisibleChange,
}: {
  task: Task | undefined;
  connected: boolean;
  theme: "light" | "dark";
  children: ReactNode;
  workspaceName: string;
  onVisibleChange: (visible: boolean) => void;
}) {
  const key = serverStorageKey(`tinycode-spatial:${task?.id ?? "draft"}`);
  const [state, setState] = useState(() => {
    try {
      return restoreSpatial(localStorage.getItem(key));
    } catch {
      return initialSpatial();
    }
  });
  const [menu, setMenu] = useState<"column" | "workspace" | "help" | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    map = useRef<HTMLDivElement>(null);
  const guards = useRef(new Map<string, () => boolean>());
  const current = state.spaces.find((w) => w.id === state.active)!;
  const bounds = {
    x: Math.min(...state.spaces.map((w) => w.x)),
    y: Math.min(...state.spaces.map((w) => w.y)),
    right: Math.max(...state.spaces.map((w) => w.x)),
    bottom: Math.max(...state.spaces.map((w) => w.y)),
  };
  const guard = (ids: string[]) =>
    ids.every((id) => guards.current.get(id)?.() ?? true);
  useEffect(() => {
    const leave = (e: Event) => {
      if (!guard(state.spaces.flatMap((w) => w.columns.map((p) => p.id))))
        e.preventDefault();
    };
    window.addEventListener("tinycode:before-task-change", leave);
    return () =>
      window.removeEventListener("tinycode:before-task-change", leave);
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      setNotice("Layout could not be saved in this browser.");
    }
  }, [key, state]);
  useEffect(() => {
    onVisibleChange(current.columns.some((p) => p.kind === "chat"));
    return () => onVisibleChange(true);
  }, [state.active, onVisibleChange]);
  useEffect(() => {
    const el = map.current;
    if (!el) return;
    el.scrollTo({
      left: 90 + (current.x - bounds.x) * 20 - (el.clientWidth - 17) / 2,
      top: 34 + (current.y - bounds.y) * 20 - (el.clientHeight - 17) / 2,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [state.active, state.spaces.length, bounds.x, bounds.y]);
  useEffect(() => {
    if (menu) {
      root.current
        ?.querySelector<HTMLElement>(
          ".spatial-menu button:not(.spatial-menu-close), .spatial-menu-close",
        )
        ?.focus();
      return;
    }
    const el = root.current?.querySelector<HTMLElement>(
      `[data-space="${state.active}"] [data-panel-index="${state.focus}"]`,
    );
    if (!el) {
      root.current
        ?.querySelector<HTMLButtonElement>(
          `[data-space="${state.active}"] .spatial-empty button`,
        )
        ?.focus({ preventScroll: true });
    }
    if (el && !el.contains(document.activeElement))
      (
        el.querySelector<HTMLElement>("textarea:not([disabled])") ||
        el.querySelector<HTMLElement>(
          'input:not([disabled]):not([type="file"]):not([type="hidden"]),[role="tree"],button:not([disabled])',
        ) ||
        el
      ).focus({ preventScroll: true });
  }, [state.active, state.focus, focusTick, menu]);
  function select(id: string, index = 0) {
    setState((s) => ({ ...s, active: id, focus: index }));
    setMenu(null);
    setFocusTick((n) => n + 1);
  }
  function move(dx: number, dy: number, create = false) {
    setState((s) => moveSpatial(s, dx, dy, create));
    setMenu(null);
  }
  function closePanel(id: string) {
    if (id === "chat") return;
    if (!guard([id])) return;
    setState((s) => ({
      ...s,
      focus: 0,
      spaces: s.spaces.map((w) => ({
        ...w,
        columns: w.columns.filter((p) => p.id !== id),
      })),
    }));
    setFocusTick((n) => n + 1);
  }
  function remove() {
    if (state.active === "home") {
      setNotice("The main workspace stays open.");
      return;
    }
    if (!guard(current.columns.map((p) => p.id))) return;
    setState(removeSpatial);
    setMenu(null);
  }
  function open(kind: SpatialPanel["kind"], path?: string, canvasId?: string) {
    const existing = state.spaces
      .flatMap((w) => w.columns.map((p, i) => ({ w, p, i })))
      .find(({ p }) => kind === "canvas" ? p.id === canvasId : p.kind === kind && p.path === path);
    if (existing) {
      select(existing.w.id, existing.i);
      return;
    }
    const replace =
      current.columns.length === 2
        ? current.columns[state.focus].kind === "chat"
          ? 1
          : state.focus
        : -1;
    if (replace >= 0 && !guard([current.columns[replace].id])) return;
    const panel: SpatialPanel = {
      id: canvasId ?? crypto.randomUUID(),
      kind,
      ...(path ? { path } : {}),
    };
    setState((s) => ({
      ...s,
      ...(kind === "canvas" && !canvasId ? {
        canvases: [...(s.canvases ?? []), { id: panel.id, name: `Canvas ${(s.canvases?.length ?? 0) + 1}` }],
      } : {}),
      focus: replace >= 0 ? replace : current.columns.length,
      spaces: s.spaces.map((w) =>
        w.id !== s.active
          ? w
          : {
              ...w,
              columns:
                replace >= 0
                  ? w.columns.map((p, i) => (i === replace ? panel : p))
                  : [...w.columns, panel],
            },
      ),
    }));
    setMenu(null);
    setFocusTick((n) => n + 1);
  }
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if (
        e.isComposing ||
        (!root.current?.contains(e.target as Node) &&
          (e.target as HTMLElement).closest('[role="dialog"],.dialog-backdrop'))
      )
        return;
      const d = directions.find((d) => d.key === e.code);
      if (menu && !e.altKey && !e.metaKey && !e.ctrlKey) {
        const box = root.current?.querySelector(".spatial-menu");
        const buttons = Array.from(
          box?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ??
            [],
        );
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") {
          e.preventDefault();
          setMenu(null);
          return;
        }
        if (menu === "workspace" && d) {
          e.preventDefault();
          box
            ?.querySelector<HTMLButtonElement>(`[data-direction="${d.key}"]`)
            ?.focus();
          return;
        }
        if (
          ["ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(e.key) &&
          buttons.length
        ) {
          e.preventDefault();
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (i +
                    (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)
                      ? -1
                      : 1) +
                    buttons.length) %
                  buttons.length
          ].focus();
          return;
        }
        if (menu === "column" && /^[1-5]$/.test(e.key)) {
          e.preventDefault();
          open(options[Number(e.key) - 1].kind);
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyJ") {
        e.preventDefault();
        open("terminal");
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.shiftKey && e.code === "Slash") {
        e.preventDefault();
        e.stopPropagation();
        setMenu((current) => (current === "help" ? null : "help"));
        return;
      }
      if (d) {
        e.preventDefault();
        e.stopPropagation();
        move(d.dx, d.dy, e.shiftKey);
        return;
      }
      if (
        ![
          "Digit0",
          "Home",
          "Digit1",
          "Digit2",
          "KeyN",
          "KeyW",
          "KeyX",
          "KeyK",
          "KeyM",
          "Enter",
          "PageUp",
          "PageDown",
        ].includes(e.code)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Digit0" || e.code === "Home") select("home");
      if (e.code === "Digit1" || e.code === "Digit2")
        select(
          state.active,
          Math.min(
            Number(e.code.at(-1)) - 1,
            Math.max(0, current.columns.length - 1),
          ),
        );
      if (e.code === "KeyN") setMenu("column");
      if (e.code === "KeyW") setMenu("workspace");
      if (e.code === "KeyK") setMenu("help");
      if (e.code === "KeyX") {
        if (e.shiftKey) {
          const p = current.columns[state.focus];
          if (p) closePanel(p.id);
        } else remove();
      }
      if (e.code === "Enter") {
        setMenu(null);
        root.current
          ?.querySelector<HTMLElement>(
            `[data-space="${state.active}"] [data-panel-index="${state.focus}"] textarea`,
          )
          ?.focus();
      }
      if (e.code === "KeyM") {
        setMenu(null);
        map.current?.querySelector<HTMLElement>("[aria-current]")?.focus();
      }
      if (e.code === "PageUp" || e.code === "PageDown") {
        const i = state.spaces.indexOf(current);
        select(
          state.spaces[
            (i + (e.code === "PageUp" ? -1 : 1) + state.spaces.length) %
              state.spaces.length
          ].id,
        );
      }
    }
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  });
  return (
    <div className="spatial-shell" ref={root}>
      <div className="spatial-nav">
        <div className="spatial-map" ref={map} aria-label="Workspace map">
          <div
            style={{
              position: "relative",
              width: (bounds.right - bounds.x) * 20 + 197,
              height: (bounds.bottom - bounds.y) * 20 + 85,
            }}
          >
            {state.spaces.map((w) => (
              <button
                key={w.id}
                title={`Workspace ${w.number} · ${w.x}, ${w.y}`}
                aria-label={`Workspace ${w.number}`}
                aria-current={w.id === state.active ? "location" : undefined}
                style={{
                  left: 90 + (w.x - bounds.x) * 20,
                  top: 34 + (w.y - bounds.y) * 20,
                }}
                onClick={() => select(w.id)}
              >
                {w.number}
              </button>
            ))}
          </div>
        </div>
        <div className="spatial-actions">
          <button
            title="Keyboard shortcuts · Option+Shift+/ (Alt+Shift+/)"
            aria-keyshortcuts="Alt+Shift+/"
            aria-label="Workspace shortcuts"
            onClick={() => setMenu("help")}
          >
            <Keyboard size={15} />
          </button>
          <button
            onClick={() => setMenu("workspace")}
            title="New workspace · Alt W"
            aria-label="New workspace"
          >
            <Grid2X2 size={15} />
          </button>
          <button
            onClick={() => setMenu("column")}
            title="Add or replace column · Alt N"
            aria-label="Add or replace column"
          >
            <Columns2 size={15} />
          </button>
        </div>
      </div>
      {notice && (
        <div className="spatial-notice" role="status">
          {notice}
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="spatial-viewport">
        {state.spaces.map((w) => (
          <section
            key={w.id}
            data-space={w.id}
            aria-label={`Workspace ${w.number}`}
            inert={w.id !== state.active}
            className="spatial-workspace"
            style={{
              transform: `translate(${(w.x - current.x) * 100}%,${(w.y - current.y) * 100}%)`,
            }}
          >
            {!w.columns.length && (
              <div className="spatial-empty">
                <button onClick={() => setMenu("column")}>
                  <Plus size={16} /> Add column <kbd>Alt N</kbd>
                </button>
              </div>
            )}
            {w.columns.map((p, i) => (
              <div
                key={p.id}
                tabIndex={-1}
                data-panel-index={i}
                className={`spatial-column ${w.id === state.active && i === state.focus ? "focused" : ""}`}
                onFocus={() => {
                  if (w.id === state.active)
                    setState((s) => (s.focus === i ? s : { ...s, focus: i }));
                }}
                onPointerDown={() => {
                  if (w.id === state.active)
                    setState((s) => (s.focus === i ? s : { ...s, focus: i }));
                }}
              >
                <div className="spatial-column-title">
                  <span>
                    {p.path ??
                      {
                        chat: "Chat",
                        files: "Files",
                        changes: "Changes",
                        terminal: "Terminal",
                        file: "File",
                        diff: "Diff",
                        canvas: state.canvases?.find((c) => c.id === p.id)?.name ?? "Canvas",
                      }[p.kind]}
                  </span>
                  {p.kind !== "chat" && (
                    <button
                      title="Close column · Alt Shift X"
                      aria-label={`Close ${p.path ?? p.kind}`}
                      onClick={() => closePanel(p.id)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                {p.kind === "chat" ? (
                  children
                ) : p.kind === "canvas" ? (
                  <Suspense fallback={<div className="panel-loading">Opening canvas…</div>}>
                    <Canvas
                      persistenceKey={serverStorageKey(`tinycode-canvas:${p.id}`)}
                      theme={theme}
                      active={w.id === state.active && i === state.focus && !menu}
                      registerGuard={(fn) => {
                        if (fn) guards.current.set(p.id, fn);
                        else guards.current.delete(p.id);
                      }}
                    />
                  </Suspense>
                ) : !task ? (
                  <div className="spatial-empty">
                    <p className="spatial-pending">
                      Available once you send your first message.
                    </p>
                  </div>
                ) : (
                  <Suspense
                    fallback={<div className="panel-loading">Opening…</div>}
                  >
                    {p.kind === "terminal" ? (
                      task.provider === "cloudflare" ? (
                        <CloudShell
                          taskId={task.id}
                          connected={connected}
                          registerGuard={(fn) => {
                            if (fn) guards.current.set(p.id, fn);
                            else guards.current.delete(p.id);
                          }}
                        />
                      ) : (
                        <Terminal
                          taskId={task.id}
                          connected={connected}
                          onHide={() => closePanel(p.id)}
                        />
                      )
                    ) : (
                      <Files
                        taskId={task.id}
                        workspaceName={workspaceName}
                        theme={theme}
                        onClose={() => closePanel(p.id)}
                        embedded
                        initialTab={
                          p.kind === "changes" || p.kind === "diff"
                            ? "changes"
                            : "files"
                        }
                        initialPath={p.path}
                        previewOnly={p.kind === "file" || p.kind === "diff"}
                        onOpenPreview={(path, diff) =>
                          open(diff ? "diff" : "file", path)
                        }
                        registerCloseGuard={(fn) => {
                          if (fn) guards.current.set(p.id, fn);
                          else guards.current.delete(p.id);
                        }}
                      />
                    )}
                  </Suspense>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
      {menu && (
        <div
          className="spatial-menu"
          role="dialog"
          aria-label={
            menu === "help"
              ? "Workspace shortcuts"
              : menu === "workspace"
                ? "New workspace"
                : "Choose column"
          }
        >
          <button
            className="spatial-menu-close"
            aria-label="Close menu"
            onClick={() => setMenu(null)}
          >
            <X size={14} />
          </button>
          {menu === "column" ? (
            <>
            {options.map((o, i) => (
              <button key={o.kind} onClick={() => open(o.kind)}>
                {o.label}
                <kbd>{i + 1}</kbd>
              </button>
            ))}
            {!!state.canvases?.length && <div className="spatial-menu-label">Saved canvases</div>}
            {state.canvases?.map((canvas) => (
              <button key={canvas.id} onClick={() => open("canvas", undefined, canvas.id)}>
                {canvas.name}
              </button>
            ))}
            </>
          ) : menu === "workspace" ? (
            directions.map((d) => (
              <button
                key={d.key}
                data-direction={d.key}
                onClick={() => move(d.dx, d.dy, true)}
              >
                <d.Icon size={14} />
                {d.name}
                <small>
                  {state.spaces.some(
                    (w) => w.x === current.x + d.dx && w.y === current.y + d.dy,
                  )
                    ? "Open existing"
                    : "New workspace"}
                </small>
              </button>
            ))
          ) : (
            <dl>
              {[
                ["Alt + arrows", "Move workspace"],
                ["Alt + Shift + arrows", "Create workspace"],
                ["Alt + 0", "Main chat"],
                ["Alt + 1 / 2", "Focus column"],
                ["Alt + N", "Add / replace column"],
                ["Alt + W", "New workspace"],
                ["Alt + X", "Remove workspace"],
                ["Alt + Shift + X", "Close column"],
                ["Alt + M", "Focus map"],
                ["Alt + Page Up / Down", "Cycle workspaces"],
                ["Alt + Enter", "Focus input"],
                ["Option / Alt + Shift + /", "Toggle cheatsheet"],
                ["⌘ / Ctrl + J", "Open terminal"],
                ["Escape", "Dismiss menu"],
              ].map(([keys, action]) => (
                <div key={keys}>
                  <dt>{action}</dt>
                  <dd>{keys}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
