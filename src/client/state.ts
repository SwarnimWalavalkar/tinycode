import { useSyncExternalStore } from "react";
import { openSocket, serverFetch } from "./connection";
import { monitorConnection } from "./connection-health";
import type {
  Approval,
  Project,
  ProviderInfo,
  ServerPacket,
  Task,
  TimelineItem,
  Turn,
  QueuedMessage,
} from "../shared/contracts";

interface ShellState {
  projects: Project[];
  tasks: Task[];
  providers: ProviderInfo[];
  connected: boolean;
  loaded: boolean;
  authRequired: boolean;
  error: string | null;
  activeTaskId: string | null;
}
let shell: ShellState = {
  projects: [],
  tasks: [],
  providers: [],
  connected: false,
  loaded: false,
  authRequired: false,
  error: null,
  activeTaskId: location.hash.slice(1) || null,
};
const shellListeners = new Set<() => void>();
export function setShell(patch: Partial<ShellState>) {
  shell = { ...shell, ...patch };
  for (const fn of shellListeners) fn();
}
export const useShell = () =>
  useSyncExternalStore(
    (fn) => {
      shellListeners.add(fn);
      return () => shellListeners.delete(fn);
    },
    () => shell,
  );
export const getShell = () => shell;

interface TimelineState {
  taskId: string | null;
  ready: boolean;
  ids: string[];
  turns: Turn[];
  hasOlder: boolean;
  approvals: Approval[];
  queue: QueuedMessage[];
  history: boolean;
}
let timeline: TimelineState = {
  taskId: null,
  ready: false,
  ids: [],
  turns: [],
  hasOlder: false,
  approvals: [],
  queue: [],
  history: false,
};
const timelineListeners = new Set<() => void>();
const rows = new Map<string, TimelineItem>();
export const getRow = (id: string) => rows.get(id);
const rowListeners = new Map<string, Set<() => void>>();
const emitTimeline = () => {
  for (const fn of timelineListeners) fn();
};
export const useTimeline = () =>
  useSyncExternalStore(
    (fn) => {
      timelineListeners.add(fn);
      return () => timelineListeners.delete(fn);
    },
    () => timeline,
  );
export const useRow = (id: string) =>
  useSyncExternalStore(
    (fn) => {
      let set = rowListeners.get(id);
      if (!set) {
        set = new Set();
        rowListeners.set(id, set);
      }
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (!set!.size) rowListeners.delete(id);
      };
    },
    () => rows.get(id),
  );
const emitRow = (id: string) => {
  for (const fn of rowListeners.get(id) ?? []) fn();
};
const setPage = (items: TimelineItem[], turns: Turn[], hasOlder: boolean, history = false) => {
  rows.clear();
  for (const item of items) {
    rows.set(item.id, item);
    emitRow(item.id);
  }
  timeline = { ...timeline, ids: items.map((i) => i.id), turns, hasOlder, history };
  emitTimeline();
};
export async function earlier() {
  const first = rows.get(timeline.ids[0]);
  if (!first || !timeline.taskId) return;
  const taskId = timeline.taskId;
  const data = await api<{ items: TimelineItem[]; turns: Turn[]; hasOlder: boolean }>(
    `/tasks/${taskId}/timeline?before=${first.seq}`,
  );
  if (timeline.taskId === taskId) setPage(data.items, data.turns, data.hasOlder, true);
}
export function latest() {
  if (shell.activeTaskId) sendSocket({ type: "subscribe", taskId: shell.activeTaskId });
}
export function selectTask(id: string | null) {
  history.replaceState(null, "", id ? `#${id}` : location.pathname);
  setShell({ activeTaskId: id });
  rows.clear();
  timeline = {
    taskId: id,
    ready: false,
    ids: [],
    turns: [],
    hasOlder: false,
    approvals: [],
    queue: [],
    history: false,
  };
  emitTimeline();
  if (id) sendSocket({ type: "subscribe", taskId: id });
}
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await serverFetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) setShell({ authRequired: true });
    throw new Error(data.error ?? "Request failed");
  }
  return data;
}
export const post = <T = unknown>(path: string, data: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let started = false;
const terminalListeners = new Set<(packet: ServerPacket) => void>();
export const onTerminal = (fn: (packet: ServerPacket) => void) => {
  terminalListeners.add(fn);
  return () => terminalListeners.delete(fn);
};
export function sendSocket(packet: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
}
export function markTaskRead(taskId: string, attentionId: string) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  sendSocket({ type: "task.read", taskId, attentionId });
  setShell({
    tasks: shell.tasks.map((task) =>
      task.id === taskId && task.attentionId === attentionId
        ? { ...task, attentionId: null }
        : task,
    ),
  });
}
function receive(p: ServerPacket) {
  if (p.type === "bootstrap")
    setShell({
      projects: p.projects,
      tasks: p.tasks,
      providers: p.providers,
      loaded: true,
      authRequired: false,
    });
  if (p.type === "tasks") setShell({ tasks: p.tasks });
  if (p.type === "timeline" && p.taskId === shell.activeTaskId) {
    timeline = {
      ...timeline,
      ready: true,
      taskId: p.taskId,
      approvals: p.approvals,
      queue: p.queue,
    };
    setPage(p.items, p.turns, p.hasOlder);
  }
  if (
    p.type === "turn" &&
    p.turn.taskId === timeline.taskId &&
    (!timeline.history || timeline.turns.some((turn) => turn.id === p.turn.id))
  ) {
    timeline = {
      ...timeline,
      turns: [...timeline.turns.filter((t) => t.id !== p.turn.id), p.turn],
    };
    emitTimeline();
  }
  if (p.type === "approvals" && p.taskId === timeline.taskId) {
    timeline = { ...timeline, approvals: p.approvals };
    emitTimeline();
  }
  if (p.type === "queue" && p.taskId === timeline.taskId) {
    timeline = { ...timeline, queue: p.queue };
    emitTimeline();
  }
  if (p.type === "item" && p.item.taskId === timeline.taskId && !timeline.history) {
    rows.set(p.item.id, p.item);
    if (!timeline.ids.includes(p.item.id)) {
      const ids = [...timeline.ids, p.item.id];
      if (ids.length > 120) {
        rows.delete(ids.shift()!);
        const turnIds = new Set(ids.map((id) => rows.get(id)?.turnId));
        timeline = {
          ...timeline,
          hasOlder: true,
          turns: timeline.turns.filter((turn) => turnIds.has(turn.id)),
        };
      }
      timeline = { ...timeline, ids };
      emitTimeline();
    } else emitRow(p.item.id);
  }
  if (p.type === "item.patch" && p.taskId === timeline.taskId) {
    const row = rows.get(p.id);
    if (row) {
      rows.set(p.id, { ...row, ...p.patch });
      emitRow(p.id);
      if (
        p.patch.status !== undefined ||
        p.patch.title !== undefined ||
        p.patch.detail !== undefined ||
        p.patch.kind !== undefined ||
        (p.patch.text !== undefined && Boolean(row.text.trim()) !== Boolean(p.patch.text.trim()))
      ) {
        timeline = { ...timeline };
        emitTimeline();
      }
    }
  }
  if (p.type === "error") setShell({ error: p.message });
  if (p.type.startsWith("terminal.")) for (const fn of terminalListeners) fn(p);
}
function connect() {
  clearTimeout(reconnect);
  const current = openSocket();
  socket = current;
  const stopMonitoring = monitorConnection(
    current,
    () => {
      attempts = 0;
      if (!shell.connected) setShell({ connected: true, error: null });
    },
    disconnect,
  );
  current.onopen = () => {
    if (shell.activeTaskId) sendSocket({ type: "subscribe", taskId: shell.activeTaskId });
  };
  current.onmessage = (e) => receive(JSON.parse(e.data));
  function disconnect() {
    stopMonitoring();
    current.onopen = current.onmessage = current.onclose = null;
    current.close();
    socket = undefined;
    started = false;
    timeline = { ...timeline, ready: false };
    emitTimeline();
    setShell({ connected: false });
    reconnect = setTimeout(() => void startConnection(), Math.min(1000 * 2 ** attempts++, 15000));
  }
  current.onclose = disconnect;
}
export async function startConnection() {
  if (started) return;
  clearTimeout(reconnect);
  started = true;
  try {
    receive(
      await api<ServerPacket>("/bootstrap", {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      }),
    );
    connect();
  } catch (e) {
    started = false;
    setShell({
      loaded: true,
      error: shell.authRequired
        ? "Enter this server's access token"
        : "Cannot reach the server. Reconnecting…",
    });
    if (!shell.authRequired) reconnect = setTimeout(() => void startConnection(), 2000);
  }
}
