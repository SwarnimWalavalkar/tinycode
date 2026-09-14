export type SpatialPanel = {
  id: string;
  kind: "chat" | "files" | "changes" | "file" | "diff" | "terminal" | "canvas";
  path?: string;
};
export type SpatialSpace = {
  id: string;
  number: number;
  x: number;
  y: number;
  columns: SpatialPanel[];
};
export type SpatialState = {
  spaces: SpatialSpace[];
  active: string;
  focus: number;
  next: number;
  canvases?: { id: string; name: string }[];
};
export const initialSpatial = (): SpatialState => ({
  spaces: [
    {
      id: "home",
      number: 1,
      x: 0,
      y: 0,
      columns: [{ id: "chat", kind: "chat" }],
    },
  ],
  active: "home",
  focus: 0,
  next: 2,
});
export function restoreSpatial(raw: string | null): SpatialState {
  try {
    const s = JSON.parse(raw || "null") as SpatialState;
    if (!s || !Array.isArray(s.spaces) || !s.spaces.length || s.spaces.length > 100)
      return initialSpatial();
    const ids = new Set<string>(),
      numbers = new Set<number>(),
      coords = new Set<string>(),
      panels = new Set<string>();
    let chats = 0,
      terminals = 0;
    for (const w of s.spaces) {
      if (
        !w ||
        typeof w.id !== "string" ||
        ids.has(w.id) ||
        !Number.isSafeInteger(w.number) ||
        w.number < 1 ||
        numbers.has(w.number) ||
        !Number.isSafeInteger(w.x) ||
        !Number.isSafeInteger(w.y) ||
        Math.abs(w.x) > 100 ||
        Math.abs(w.y) > 100 ||
        coords.has(`${w.x},${w.y}`) ||
        !Array.isArray(w.columns) ||
        w.columns.length > 2
      )
        return initialSpatial();
      ids.add(w.id);
      numbers.add(w.number);
      coords.add(`${w.x},${w.y}`);
      for (const p of w.columns) {
        if (
          !p ||
          typeof p.id !== "string" ||
          panels.has(p.id) ||
          !["chat", "files", "changes", "file", "diff", "terminal", "canvas"].includes(p.kind) ||
          (["file", "diff"].includes(p.kind) && (typeof p.path !== "string" || !p.path))
        )
          return initialSpatial();
        panels.add(p.id);
        if (p.kind === "chat") chats++;
        if (p.kind === "terminal") terminals++;
      }
    }
    if (s.canvases !== undefined && (
      !Array.isArray(s.canvases) ||
      s.canvases.some((c) => !c || typeof c.id !== "string" || !c.id || typeof c.name !== "string" || !c.name) ||
      new Set(s.canvases.map((c) => c.id)).size !== s.canvases.length
    )) return initialSpatial();
    const home = s.spaces.find((w) => w.id === "home");
    if (
      !home ||
      home.x !== 0 ||
      home.y !== 0 ||
      home.columns[0]?.kind !== "chat" ||
      home.columns[0]?.id !== "chat" ||
      chats !== 1 ||
      terminals > 1 ||
      !ids.has(s.active) ||
      ![0, 1].includes(s.focus) ||
      !Number.isSafeInteger(s.next) ||
      s.next <= Math.max(...numbers)
    )
      return initialSpatial();
    return {
      ...s,
      focus: Math.min(
        s.focus,
        Math.max(0, s.spaces.find((w) => w.id === s.active)!.columns.length - 1),
      ),
    };
  } catch {
    return initialSpatial();
  }
}
export function moveSpatial(
  s: SpatialState,
  dx: number,
  dy: number,
  create: boolean,
): SpatialState {
  const current = s.spaces.find((w) => w.id === s.active)!;
  const target = s.spaces.find((w) => w.x === current.x + dx && w.y === current.y + dy);
  if (target) return { ...s, active: target.id, focus: 0 };
  if (
    !create ||
    s.spaces.length >= 100 ||
    Math.abs(current.x + dx) > 100 ||
    Math.abs(current.y + dy) > 100
  )
    return s;
  const w: SpatialSpace = {
    id: crypto.randomUUID(),
    number: s.next,
    x: current.x + dx,
    y: current.y + dy,
    columns: [],
  };
  return {
    ...s,
    spaces: [...s.spaces, w],
    active: w.id,
    focus: 0,
    next: s.next + 1,
  };
}
export function removeSpatial(s: SpatialState): SpatialState {
  if (s.active === "home") return s;
  const current = s.spaces.find((w) => w.id === s.active)!;
  const spaces = s.spaces.filter((w) => w !== current);
  const nearest = [...spaces].sort(
    (a, b) =>
      Math.abs(a.x - current.x) +
      Math.abs(a.y - current.y) -
      Math.abs(b.x - current.x) -
      Math.abs(b.y - current.y),
  )[0];
  return { ...s, spaces, active: nearest.id, focus: 0 };
}
