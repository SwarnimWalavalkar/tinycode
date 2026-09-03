import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Project,
  Task,
  TimelineItem,
  TimelineKind,
  TaskStatus,
  ProviderId,
  Turn,
  QueuedMessage,
  ImageAttachment,
} from "../shared/contracts.js";
import { isAttentionStatus } from "../shared/attention.js";
import { taskTitle, type TitleMessage } from "../shared/titles.js";

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  is_git: number;
  created_at: string;
};
type TaskRow = {
  id: string;
  project_id: string | null;
  title: string;
  provider: string;
  model: string | null;
  thinking_level: string | null;
  permission_mode: Task["permissionMode"];
  resolved_model: string | null;
  status: string;
  attention_id: string | null;
  cwd: string;
  worktree_path: string | null;
  native_session_id: string | null;
  created_at: string;
  updated_at: string;
};
type ItemRow = {
  id: string;
  task_id: string;
  turn_id: string | null;
  seq: number;
  kind: string;
  text: string;
  title: string | null;
  status: string | null;
  detail: string | null;
  created_at: string;
  images: string | null;
};

const project = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  path: r.path,
  branch: r.branch,
  isGit: !!r.is_git,
  createdAt: r.created_at,
});
const task = (r: TaskRow): Task => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  provider: r.provider as ProviderId,
  model: r.model,
  thinkingLevel: r.thinking_level,
  permissionMode: r.permission_mode,
  resolvedModel: r.resolved_model,
  status: r.status as TaskStatus,
  attentionId: r.attention_id,
  cwd: r.cwd,
  worktreePath: r.worktree_path,
  nativeSessionId: r.native_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const item = (r: ItemRow): TimelineItem => ({
  id: r.id,
  taskId: r.task_id,
  ...(r.turn_id ? { turnId: r.turn_id } : {}),
  seq: r.seq,
  kind: r.kind as TimelineKind,
  text: r.text,
  ...(r.title ? { title: r.title } : {}),
  ...(r.status ? { status: r.status as TimelineItem["status"] } : {}),
  ...(r.detail ? { detail: r.detail } : {}),
  createdAt: r.created_at,
  ...(r.images ? { images: JSON.parse(r.images) } : {}),
});

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, branch TEXT, is_git INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, status TEXT NOT NULL, cwd TEXT NOT NULL, worktree_path TEXT, native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at DESC);
      CREATE TABLE IF NOT EXISTS timeline (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', title TEXT, status TEXT, detail TEXT, created_at TEXT NOT NULL, UNIQUE(task_id, seq));
      CREATE INDEX IF NOT EXISTS timeline_task_seq ON timeline(task_id, seq DESC);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    if (
      !(this.db.pragma("table_info(tasks)") as { name: string }[]).some(
        (column) => column.name === "resolved_model",
      )
    )
      this.db.exec("ALTER TABLE tasks ADD COLUMN resolved_model TEXT");
    if (
      !(this.db.pragma("table_info(tasks)") as { name: string }[]).some(
        (column) => column.name === "attention_id",
      )
    )
      this.db.exec("ALTER TABLE tasks ADD COLUMN attention_id TEXT");
    if (
      !(this.db.pragma("table_info(tasks)") as { name: string }[]).some(
        (column) => column.name === "thinking_level",
      )
    )
      this.db.exec("ALTER TABLE tasks ADD COLUMN thinking_level TEXT");
    if (
      (this.db.pragma("table_info(tasks)") as { name: string; notnull: number }[]).some(
        (column) => column.name === "project_id" && column.notnull,
      )
    ) {
      // Rebuild without cascading deletion into existing transcripts.
      this.db.pragma("foreign_keys = OFF");
      try {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE tasks_optional_project (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, status TEXT NOT NULL, cwd TEXT NOT NULL, worktree_path TEXT, native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_model TEXT, attention_id TEXT, thinking_level TEXT);
            INSERT INTO tasks_optional_project SELECT id, project_id, title, provider, model, status, cwd, worktree_path, native_session_id, created_at, updated_at, resolved_model, attention_id, thinking_level FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_optional_project RENAME TO tasks;
            CREATE INDEX tasks_updated ON tasks(updated_at DESC);
          `);
          if ((this.db.pragma("foreign_key_check") as unknown[]).length)
            throw new Error("Task migration failed its foreign key check");
        })();
      } finally {
        this.db.pragma("foreign_keys = ON");
      }
    }
    if (
      !(this.db.pragma("table_info(tasks)") as { name: string }[]).some(
        (column) => column.name === "permission_mode",
      )
    )
      this.db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT");
    if (
      !(this.db.pragma("table_info(tasks)") as { name: string }[]).some(
        (column) => column.name === "title_revision",
      )
    ) {
      this.db.transaction(() =>
        this.db.exec(
          "ALTER TABLE tasks ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0; ALTER TABLE tasks ADD COLUMN title_state TEXT NOT NULL DEFAULT 'idle'",
        ),
      )();
    }
    this.db
      .prepare(
        "UPDATE tasks SET status = 'interrupted', attention_id = ?, updated_at = ? WHERE status IN ('running', 'waiting')",
      )
      .run(randomUUID(), new Date().toISOString());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL);
      UPDATE turns SET status = 'interrupted' WHERE status = 'running';
    `);
    if (
      !(this.db.pragma("table_info(timeline)") as { name: string }[]).some(
        (column) => column.name === "turn_id",
      )
    )
      this.db.exec("ALTER TABLE timeline ADD COLUMN turn_id TEXT REFERENCES turns(id)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queued_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, text TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue_task_seq ON queued_messages(task_id, seq);
      UPDATE queued_messages SET status = 'blocked', error = 'Delivery was interrupted. Check the transcript before resending.' WHERE status = 'sending';
      UPDATE queued_messages SET status = 'blocked', error = 'The previous turn ended. Send as a new message when ready.' WHERE mode = 'steer' AND status = 'pending';
    `);
    if (
      !(this.db.pragma("table_info(queued_messages)") as { name: string }[]).some(
        (column) => column.name === "position",
      )
    ) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE queued_messages ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
        this.db.exec("UPDATE queued_messages SET position = seq");
      })();
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, task_id TEXT REFERENCES tasks(id), created_at TEXT NOT NULL)`,
    );
    for (const table of ["timeline", "queued_messages"]) {
      if (
        !(this.db.pragma(`table_info(${table})`) as { name: string }[]).some(
          (column) => column.name === "images",
        )
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN images TEXT`);
    }
  }
  queue(taskId: string): QueuedMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id, task_id taskId, text, mode, status, error, created_at createdAt, images FROM queued_messages WHERE task_id = ? ORDER BY position, seq",
      )
      .all(taskId) as (Omit<QueuedMessage, "images"> & { images: string | null })[];
    return rows.map(({ images, ...row }) => ({
      ...row,
      ...(images ? { images: JSON.parse(images) } : {}),
    }));
  }
  enqueue(message: QueuedMessage) {
    this.db
      .prepare(
        "INSERT INTO queued_messages (id, task_id, text, mode, status, error, created_at, images, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM queued_messages WHERE task_id = ?))",
      )
      .run(
        message.id,
        message.taskId,
        message.text,
        message.mode,
        message.status,
        message.error,
        message.createdAt,
        message.images?.length ? JSON.stringify(message.images) : null,
        message.taskId,
      );
  }
  patchQueued(
    taskId: string,
    id: string,
    status: QueuedMessage["status"],
    error: string | null = null,
    mode?: QueuedMessage["mode"],
  ) {
    this.db
      .prepare(
        "UPDATE queued_messages SET status = ?, error = ?, mode = COALESCE(?, mode) WHERE task_id = ? AND id = ?",
      )
      .run(status, error, mode ?? null, taskId, id);
  }
  removeQueued(taskId: string, id: string) {
    this.db.prepare("DELETE FROM queued_messages WHERE task_id = ? AND id = ?").run(taskId, id);
  }
  editQueued(
    taskId: string,
    id: string,
    text: string,
    expectedText: string,
    images?: ImageAttachment[],
    expectedImages?: string[],
  ) {
    this.db.transaction(() => {
      const message = this.editableQueued(taskId, id);
      const attachments = images ?? message.images;
      const currentImages = JSON.stringify((message.images ?? []).map((image) => image.id));
      if (
        message.text === text.trim() &&
        currentImages === JSON.stringify((attachments ?? []).map((image) => image.id))
      )
        return;
      if (
        message.text !== expectedText ||
        (expectedImages && JSON.stringify(expectedImages) !== currentImages)
      )
        throw new Error(
          "This message was edited elsewhere. Reopen the editor to see the latest version.",
        );
      if (!text.trim() && !attachments?.length)
        throw new Error("Write a message or keep an attached image");
      this.db
        .prepare("UPDATE queued_messages SET text = ?, images = ? WHERE task_id = ? AND id = ?")
        .run(text.trim(), attachments?.length ? JSON.stringify(attachments) : null, taskId, id);
    })();
  }
  moveQueued(taskId: string, id: string, beforeId: string | null) {
    this.db.transaction(() => {
      this.editableQueued(taskId, id);
      if (beforeId === id) return;
      if (beforeId !== null) this.editableQueued(taskId, beforeId);
      const queue = this.queue(taskId);
      const ids = queue
        .filter((message) => message.status !== "sending" && message.id !== id)
        .map((message) => message.id);
      ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, id);
      const update = this.db.prepare(
        "UPDATE queued_messages SET position = ? WHERE task_id = ? AND id = ?",
      );
      let next = 0;
      // Native deliveries already in flight retain their slot. Only unsent messages move.
      queue.forEach((message, index) => {
        update.run(index, taskId, message.status === "sending" ? message.id : ids[next++]);
      });
    })();
  }
  private editableQueued(taskId: string, id: string) {
    const message = this.queue(taskId).find((message) => message.id === id);
    if (!message) throw new Error("This message is no longer in the queue");
    if (message.status === "sending") throw new Error("This message is already being delivered");
    return message;
  }
  projects() {
    return (
      this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[]
    ).map(project);
  }
  project(id: string) {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    return r && project(r);
  }
  insertProject(p: Project) {
    this.db
      .prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.path, p.branch, Number(p.isGit), p.createdAt);
  }
  tasks() {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as TaskRow[]).map(
      task,
    );
  }
  task(id: string) {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return r && task(r);
  }
  insertTask(t: Task) {
    this.db
      .prepare(
        "INSERT INTO tasks (id,project_id,title,provider,model,status,cwd,worktree_path,native_session_id,created_at,updated_at,attention_id,thinking_level,permission_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        t.id,
        t.projectId,
        t.title,
        t.provider,
        t.model,
        t.status,
        t.cwd,
        t.worktreePath,
        t.nativeSessionId,
        t.createdAt,
        t.updatedAt,
        t.attentionId,
        t.thinkingLevel,
        t.permissionMode ?? null,
      );
  }
  prepareTitle(id: string, text: string) {
    if (
      this.db.prepare("SELECT 1 FROM timeline WHERE task_id = ? AND kind = 'user' LIMIT 1").get(id)
    )
      return false;
    return (
      this.db
        .prepare(
          "UPDATE tasks SET title = ?, title_state = 'pending' WHERE id = ? AND title_revision = 0 AND title_state = 'idle'",
        )
        .run((text.replace(/\s+/g, " ").trim() || "Image attachment").slice(0, 64), id).changes > 0
    );
  }
  titleState(id: string) {
    return this.db
      .prepare("SELECT title_revision revision, title_state state FROM tasks WHERE id = ?")
      .get(id) as { revision: number; state: string } | undefined;
  }
  pendingTitles() {
    return this.db.prepare("SELECT id FROM tasks WHERE title_state = 'pending'").all() as {
      id: string;
    }[];
  }
  applyTitle(id: string, title: string, revision: number) {
    return (
      this.db
        .prepare(
          "UPDATE tasks SET title = ?, title_state = 'ready', title_revision = title_revision + 1 WHERE id = ? AND title_revision = ? AND title_state = 'pending'",
        )
        .run(taskTitle(title), id, revision).changes > 0
    );
  }
  failTitle(id: string, revision: number) {
    this.db
      .prepare(
        "UPDATE tasks SET title_state = 'failed' WHERE id = ? AND title_revision = ? AND title_state = 'pending'",
      )
      .run(id, revision);
  }
  renameTask(id: string, title: string) {
    const changed = this.db
      .prepare(
        "UPDATE tasks SET title = ?, title_state = 'manual', title_revision = title_revision + 1 WHERE id = ?",
      )
      .run(taskTitle(title), id);
    if (!changed.changes) throw new Error("Task not found");
    return this.task(id)!;
  }
  titleMessages(id: string, firstOnly = false) {
    const first = this.db
      .prepare(
        "SELECT seq, kind role, CASE WHEN text = '' THEN 'Image attachment' ELSE substr(text, 1, 3000) END text FROM timeline WHERE task_id = ? AND kind = 'user' ORDER BY seq LIMIT 1",
      )
      .get(id) as (TitleMessage & { seq: number }) | undefined;
    if (!first) return [];
    const recent = firstOnly
      ? []
      : (this.db
          .prepare(
            "SELECT seq, kind role, substr(text, 1, 1200) text FROM timeline WHERE task_id = ? AND seq > ? AND kind IN ('user', 'assistant') ORDER BY seq DESC LIMIT 7",
          )
          .all(id, first.seq) as (TitleMessage & { seq: number })[]);
    return [first, ...recent.reverse()];
  }
  patchTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | "title"
        | "status"
        | "nativeSessionId"
        | "model"
        | "resolvedModel"
        | "thinkingLevel"
        | "permissionMode"
      >
    >,
  ) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const map: Record<string, string> = {
      nativeSessionId: "native_session_id",
      resolvedModel: "resolved_model",
      thinkingLevel: "thinking_level",
      permissionMode: "permission_mode",
    };
    const sets = entries.map(([k]) => `${map[k] ?? k} = ?`);
    const values = entries.map(([, v]) => v);
    if (patch.status) {
      // Only a new completion/failure creates unread activity. Metadata updates and
      // repeated status events must not bring back an already-read dot.
      if (isAttentionStatus(patch.status)) {
        sets.push("attention_id = CASE WHEN status != ? THEN ? ELSE attention_id END");
        values.push(patch.status, randomUUID());
      } else sets.push("attention_id = NULL");
    }
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
  }
  markTaskRead(id: string, attentionId: string) {
    // A delayed acknowledgement may clear only the event the browser actually saw.
    return (
      this.db
        .prepare("UPDATE tasks SET attention_id = NULL WHERE id = ? AND attention_id = ?")
        .run(id, attentionId).changes > 0
    );
  }
  claimRequest(requestId: string, taskId: string) {
    try {
      this.db
        .prepare("INSERT INTO requests VALUES (?, ?, ?)")
        .run(requestId, taskId, new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }
  startTurn(taskId: string): Turn {
    const turn: Turn = {
      id: randomUUID(),
      taskId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
    };
    this.db
      .prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?)")
      .run(turn.id, turn.taskId, turn.startedAt, null, turn.status);
    return turn;
  }
  finishTurn(id: string, status: Exclude<Turn["status"], "running">): Turn {
    this.db
      .prepare("UPDATE turns SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(status, new Date().toISOString(), id);
    return this.db
      .prepare(
        "SELECT id, task_id taskId, started_at startedAt, finished_at finishedAt, status FROM turns WHERE id = ?",
      )
      .get(id) as Turn;
  }
  append(input: Omit<TimelineItem, "seq" | "createdAt"> & { createdAt?: string }): TimelineItem {
    const next = (
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0)+1 n FROM timeline WHERE task_id=?")
        .get(input.taskId) as { n: number }
    ).n;
    const row: TimelineItem = {
      ...input,
      seq: next,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO timeline (id, task_id, seq, kind, text, title, status, detail, created_at, turn_id, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.taskId,
        row.seq,
        row.kind,
        row.text,
        row.title ?? null,
        row.status ?? null,
        row.detail ?? null,
        row.createdAt,
        row.turnId ?? null,
        row.images?.length ? JSON.stringify(row.images) : null,
      );
    return row;
  }
  patchItem(
    taskId: string,
    id: string,
    patch: Partial<Pick<TimelineItem, "text" | "title" | "status" | "detail">>,
  ) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    this.db
      .prepare(
        `UPDATE timeline SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE task_id=? AND id=?`,
      )
      .run(...entries.map(([, v]) => v), taskId, id);
  }
  timeline(taskId: string, before?: number, limit = 120) {
    const rows = (
      before === undefined
        ? this.db
            .prepare("SELECT * FROM timeline WHERE task_id=? ORDER BY seq DESC LIMIT ?")
            .all(taskId, limit)
        : this.db
            .prepare("SELECT * FROM timeline WHERE task_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
            .all(taskId, before, limit)
    ) as ItemRow[];
    const items = rows.reverse().map(item);
    const min = items[0]?.seq ?? 0;
    const hasOlder = min > 1;
    const turnIds = [...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : [])))];
    const turns = turnIds.length
      ? (this.db
          .prepare(
            `SELECT id, task_id taskId, started_at startedAt, finished_at finishedAt, status FROM turns WHERE id IN (${turnIds.map(() => "?").join(",")})`,
          )
          .all(...turnIds) as Turn[])
      : [];
    return { items, hasOlder, turns };
  }
}
