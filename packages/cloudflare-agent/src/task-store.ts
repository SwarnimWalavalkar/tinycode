import type {
  QueuedMessage,
  ServerPacket,
  Task,
  TimelineItem,
  Turn,
} from "../../../src/shared/contracts.js";
import { HttpError } from "./http.js";

export type RequestRow = Omit<QueuedMessage, "status"> & {
  status: QueuedMessage["status"] | "settled";
  fingerprint: string;
  position: number;
};
export interface CloudEvent {
  cursor: number;
  packet: ServerPacket;
}
const MAX_TEXT = 128 * 1024;
export const bounded = (s: string) =>
  s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}\n[output truncated]`;

/** The task DO is the only writer. Materialized rows and their events commit together. */
export class TaskStore {
  constructor(
    readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
  ) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS task_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_requests (id TEXT PRIMARY KEY, position INTEGER NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_turns (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
    `);
  }
  get<T>(key: string): T | undefined {
    const row = this.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM task_values WHERE key = ?", key)
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  set(key: string, value: unknown) {
    this.storage.sql.exec(
      "INSERT INTO task_values VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  task(): Task {
    const task = this.get<Task>("task");
    if (!task) throw new HttpError(404, "Task not found");
    return task;
  }
  patchTask(patch: Partial<Task>) {
    const task = {
      ...this.task(),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.set("task", task);
    return task;
  }
  cursor() {
    return this.get<number>("cursor") ?? 0;
  }
  emit(packet: ServerPacket) {
    const row = this.storage.sql
      .exec<{
        cursor: number;
      }>("INSERT INTO task_events(value) VALUES (?) RETURNING cursor", JSON.stringify(packet))
      .toArray()[0];
    this.set("cursor", row.cursor);
    // The durable materialized transcript remains complete; old cursors receive a snapshot.
    this.storage.sql.exec(
      "DELETE FROM task_events WHERE cursor <= ?",
      row.cursor - 2000,
    );
    return row.cursor;
  }
  events(after: number, limit = 100): CloudEvent[] {
    const rows = this.storage.sql
      .exec<{
        cursor: number;
        size: number;
      }>("SELECT cursor,length(CAST(value AS BLOB)) AS size FROM task_events WHERE cursor > ? ORDER BY cursor LIMIT ?", after, limit)
      .toArray();
    const result: CloudEvent[] = [];
    let size = 0;
    for (const row of rows) {
      if (result.length && size + row.size > 2 * 1024 * 1024) break;
      const value = this.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM task_events WHERE cursor=?", row.cursor)
        .toArray()[0].value;
      result.push({ cursor: row.cursor, packet: JSON.parse(value) });
      size += row.size;
    }
    return result;
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  importItems(items: TimelineItem[], turns: Turn[]) {
    this.transaction(() => {
      for (const item of items) {
        if (
          item.taskId !== this.task().id ||
          !Number.isSafeInteger(item.seq) ||
          item.seq < 1
        )
          throw new HttpError(400, "Invalid imported item");
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO task_items(seq,id,value) VALUES (?,?,?)",
          item.seq,
          item.id,
          JSON.stringify({
            ...item,
            text: bounded(item.text),
            ...(item.detail ? { detail: bounded(item.detail) } : {}),
          }),
        );
      }
      for (const turn of turns) {
        if (turn.taskId !== this.task().id)
          throw new HttpError(400, "Invalid imported turn");
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO task_turns VALUES (?,?)",
          turn.id,
          JSON.stringify(turn),
        );
      }
    });
  }
  request(id: string): RequestRow | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM task_requests WHERE id=?", id)
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  requests(): RequestRow[] {
    return this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM task_requests WHERE status != 'settled' ORDER BY position",
      )
      .toArray()
      .map((r) => JSON.parse(r.value));
  }
  putRequest(row: RequestRow) {
    this.storage.sql.exec(
      "INSERT INTO task_requests VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,status=excluded.status,value=excluded.value",
      row.id,
      row.position,
      row.status,
      JSON.stringify(row),
    );
  }
  queue(): QueuedMessage[] {
    return this.requests().map(
      ({ fingerprint, position, ...row }) => row as QueuedMessage,
    );
  }
  emitQueue() {
    this.emit({ type: "queue", taskId: this.task().id, queue: this.queue() });
  }
  turn(turn: Turn) {
    this.storage.sql.exec(
      "INSERT INTO task_turns VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      turn.id,
      JSON.stringify(turn),
    );
    this.emit({ type: "turn", turn });
  }
  item(item: Omit<TimelineItem, "seq" | "createdAt" | "taskId">) {
    const value: TimelineItem = {
      ...item,
      text: bounded(item.text),
      ...(item.detail ? { detail: bounded(item.detail) } : {}),
      taskId: this.task().id,
      seq: 0,
      createdAt: new Date().toISOString(),
    };
    const row = this.storage.sql
      .exec<{
        seq: number;
      }>("INSERT INTO task_items(id,value) VALUES (?,?) RETURNING seq", item.id, JSON.stringify(value))
      .toArray()[0];
    value.seq = row.seq;
    this.storage.sql.exec(
      "UPDATE task_items SET value=? WHERE id=?",
      JSON.stringify(value),
      item.id,
    );
    this.emit({ type: "item", item: value });
    return value;
  }
  patchItem(id: string, patch: Partial<TimelineItem>, delta?: string) {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM task_items WHERE id=?", id)
      .toArray()[0];
    if (!row) return;
    const previous = JSON.parse(row.value) as TimelineItem;
    const value = { ...previous, ...patch };
    if (delta !== undefined) {
      const addition = delta.slice(
        0,
        Math.max(0, MAX_TEXT - previous.text.length),
      );
      value.text = previous.text + addition;
      if (!addition) return;
      this.emit({
        type: "item.delta",
        taskId: value.taskId,
        id,
        text: addition,
      });
    } else {
      if (patch.text !== undefined)
        patch.text = value.text = bounded(patch.text);
      this.emit({ type: "item.patch", taskId: value.taskId, id, patch });
    }
    this.storage.sql.exec(
      "UPDATE task_items SET value=? WHERE id=?",
      JSON.stringify(value),
      id,
    );
  }
  failOpenItems() {
    for (const row of this.storage.sql
      .exec<{
        id: string;
        value: string;
      }>("SELECT id,value FROM task_items WHERE json_extract(value,'$.status')='running'")
      .toArray())
      this.patchItem(row.id, { status: "failed" });
  }
  timeline(before = Number.MAX_SAFE_INTEGER) {
    const rows = this.storage.sql
      .exec<{
        seq: number;
        size: number;
      }>("SELECT seq,length(CAST(value AS BLOB)) AS size FROM task_items WHERE seq < ? ORDER BY seq DESC LIMIT 121", before)
      .toArray();
    const items: TimelineItem[] = [];
    let size = 0;
    for (const row of rows) {
      if (
        items.length >= 120 ||
        (items.length && size + row.size > 4 * 1024 * 1024)
      )
        break;
      const value = this.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM task_items WHERE seq=?", row.seq)
        .toArray()[0].value;
      items.push(JSON.parse(value));
      size += row.size;
    }
    items.reverse();
    const ids = [
      ...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : []))),
    ];
    const turns = ids.flatMap((id) =>
      this.storage.sql
        .exec<{ value: string }>("SELECT value FROM task_turns WHERE id=?", id)
        .toArray()
        .map((r) => JSON.parse(r.value) as Turn),
    );
    return { items, turns, hasOlder: rows.length > items.length };
  }
  snapshot(): ServerPacket {
    return {
      type: "timeline",
      taskId: this.task().id,
      ...this.timeline(),
      queue: this.queue(),
      approvals: [],
      cursor: this.cursor(),
    };
  }
}
