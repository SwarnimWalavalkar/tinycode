import { DurableObject } from "cloudflare:workers";
import type {
  ImageAttachment,
  ProviderInfo,
  ServerPacket,
  Task,
} from "../../../src/shared/contracts.js";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_IMAGE_BYTES,
} from "../../../src/shared/images.js";
import type { Env } from "./env.js";
import {
  body,
  bytes,
  checked,
  failure,
  HttpError,
  identifier,
  internal,
  json,
  publicError,
} from "./http.js";
import { modelCatalog } from "./models.js";
import { gatewayCredential } from "./gateway.js";
import type { CloudEvent } from "./task-store.js";

type Peer = { taskId?: string; generation: string; syncing: boolean; expiresAt?: number };
import { agentName, imageKey, LEGACY_OWNER, ownerId, personalWorkspace } from "./ownership.js";

type ImageRecord = ImageAttachment & {
  taskId: string | null;
  deleted?: boolean;
};

export function providers(env: Env): ProviderInfo[] {
  let available = false;
  try {
    available = !!gatewayCredential(env) && modelCatalog(env).models.length > 0;
  } catch (error) {
    console.error("Cloudflare provider configuration is invalid:", error);
  }
  return [
    {
      id: "cloudflare",
      name: "Durable Agent",
      command: "",
      available,
      readiness: available ? "ready" : "unauthenticated",
      capabilities: {
        resume: true,
        steer: true,
        interrupt: true,
        approvals: "none",
        subagents: "none",
      },
    },
  ];
}

/** Per-user directory and socket fanout. Task DOs own task state; this SQL index is a projection. */
export class TaskDirectory extends DurableObject<Env> {
  private pending = new Map<WebSocket, CloudEvent[]>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS task_creation_requests (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, value TEXT NOT NULL, init TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    for (const socket of ctx.getWebSockets())
      if ((socket.deserializeAttachment() as Peer)?.syncing)
        socket.close(1012, "Reconnect to synchronize");
  }
  private owner() {
    return this.ctx.storage.sql.exec<{ owner: string }>("SELECT created_by AS owner FROM workspace").toArray()[0]?.owner ?? LEGACY_OWNER;
  }
  private workspace() { return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM workspace").toArray()[0]?.id ?? "default"; }
  private ownsTask(id: string) {
    if (!this.ctx.storage.sql.exec("SELECT id FROM tasks WHERE id=? AND cursor != -2", id).toArray().length)
      throw new HttpError(404, "Task not found");
  }
  private tasks(): Task[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM tasks WHERE cursor >= 0 ORDER BY json_extract(value,'$.updatedAt') DESC",
      )
      .toArray()
      .map((r) => JSON.parse(r.value));
  }
  private bootstrap(): ServerPacket {
    return {
      type: "bootstrap",
      projects: [],
      tasks: this.tasks(),
      providers: providers(this.env),
    };
  }
  private send(socket: WebSocket, packet: ServerPacket) {
    try {
      const peer = socket.deserializeAttachment() as Peer;
      if (peer.expiresAt && peer.expiresAt <= Date.now()) { socket.close(1008, "Sign in again"); return; }
      socket.send(JSON.stringify(packet));
    } catch {
      try {
        socket.close(1013, "Reconnect to synchronize");
      } catch {}
    }
  }
  private task(id: string) {
    return this.env.AGENTS.get(this.env.AGENTS.idFromName(agentName(this.workspace(), identifier(id))));
  }
  private image(id: string): ImageRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM images WHERE id=?", identifier(id))
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private deleted(id: string) {
    return (
      this.ctx.storage.sql
        .exec<{ cursor: number }>("SELECT cursor FROM tasks WHERE id=?", id)
        .toArray()[0]?.cursor === -2
    );
  }
  private putImage(image: ImageRecord) {
    this.ctx.storage.sql.exec(
      "INSERT INTO images VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      image.id,
      JSON.stringify(image),
    );
  }
  private async imageRequest(request: Request, id: string): Promise<Response> {
    identifier(id);
    const url = new URL(request.url);
    if (request.method === "PUT") {
      const data = await bytes(request, MAX_IMAGE_BYTES);
      const mimeType = imageType(data);
      if (mimeType !== request.headers.get("content-type")?.split(";")[0])
        throw new HttpError(400, "Image format does not match its file type");
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          const previous = this.image(id);
          if (previous?.deleted)
            throw new HttpError(
              409,
              "This image ID was deleted; attach it again",
            );
          const key = imageKey(this.workspace(), id);
          const hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", data.slice().buffer),
            ),
          )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const retained = await this.env.ATTACHMENTS.head(key);
          if (retained && retained.customMetadata?.hash !== hash)
            throw new HttpError(409, "This image ID is already in use");
          const name = (url.searchParams.get("name") ?? "Image")
            .replace(/[\x00-\x1f/\\]/g, "_")
            .slice(0, 160);
          const image: ImageRecord = previous ?? {
            id,
            name,
            mimeType,
            size: data.length,
            taskId: null,
          };
          if (!retained)
            await this.env.ATTACHMENTS.put(key, data, {
              httpMetadata: { contentType: mimeType },
              customMetadata: { hash },
            });
          this.putImage(image);
          return json(publicImage(image));
        } catch (error) {
          return failure(error);
        }
      });
    }
    if (request.method === "DELETE") {
      await bytes(request, 1024);
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          const image = this.image(id);
          if (image?.taskId) return json({ ok: true });
          if (image) this.putImage({ ...image, deleted: true });
          await this.env.ATTACHMENTS.delete(imageKey(this.workspace(), id));
          return json({ ok: true });
        } catch (error) {
          return failure(error);
        }
      });
    }
    if (request.method !== "GET")
      throw new HttpError(405, "Method not allowed");
    const image = this.image(id);
    if (!image || image.deleted || (image.taskId && this.deleted(image.taskId)))
      throw new HttpError(404, "Image not found");
    const object = await this.env.ATTACHMENTS.get(imageKey(this.workspace(), id));
    if (!object) throw new HttpError(404, "Image not found");
    return new Response(object.body, {
      headers: {
        "content-type": image.mimeType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const owner = ownerId(request.headers.get("x-tinycode-owner") ?? LEGACY_OWNER);
      this.ctx.storage.sql.exec("INSERT INTO workspace SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM workspace)", personalWorkspace(owner), owner);
      if (this.owner() !== owner) throw new HttpError(403, "Account mismatch");
      if (url.pathname === "/close-sockets") {
        for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Signed out");
        return json({ ok: true });
      }
      const route = url.pathname.match(/^\/task\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);
      if (route) {
        if (route[2] === "init") throw new HttpError(404, "Not found");
        this.ownsTask(route[1]);
        const target = new URL(`https://internal/${route[2] ?? "state"}`);
        target.search = url.search;
        return await this.task(route[1]).fetch(new Request(target, request));
      }
      if (url.pathname === "/socket") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          throw new HttpError(426, "Expected WebSocket");
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({
          generation: crypto.randomUUID(),
          syncing: false,
          expiresAt: Number(request.headers.get("x-tinycode-session-expires")) || undefined,
        } satisfies Peer);
        this.send(pair[1], this.bootstrap());
        return new Response(null, {
          status: 101,
          webSocket: pair[0],
          headers: { "sec-websocket-protocol": "tinycode" },
        });
      }
      const image = url.pathname.match(/^\/images\/([A-Za-z0-9_-]+)$/);
      if (image) return await this.imageRequest(request, image[1]);
      if (url.pathname === "/bootstrap") return json(this.bootstrap());
      if (url.pathname === "/tasks" && request.method === "GET")
        return json(this.tasks());
      const input = await body(
        request,
        url.pathname === "/publish" ? 8 * 1024 * 1024 : 1024 * 1024,
      );
      if (url.pathname === "/delete") {
        const id = identifier(input.id);
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET cursor=-2,value='{}',init='{}' WHERE id=?",
          id,
        );
        for (const socket of this.ctx.getWebSockets()) {
          const peer = socket.deserializeAttachment() as Peer;
          if (peer.taskId === id) {
            this.pending.delete(socket);
            socket.serializeAttachment({
              generation: crypto.randomUUID(),
              syncing: false,
              expiresAt: peer.expiresAt,
            } satisfies Peer);
          }
          this.send(socket, { type: "tasks", tasks: this.tasks() });
        }
        // Bounded, retryable R2 cleanup. The task tombstone immediately denies reads/claims.
        const images = this.ctx.storage.sql
          .exec<{
            id: string;
          }>("SELECT id FROM images WHERE json_extract(value,'$.taskId')=? AND COALESCE(json_extract(value,'$.deleted'),0)=0 LIMIT 100", id)
          .toArray();
        if (images.length) {
          await this.env.ATTACHMENTS.delete(
            images.map((image) => imageKey(this.workspace(), image.id)),
          );
          this.ctx.storage.transactionSync(() => {
            for (const image of images)
              this.ctx.storage.sql.exec(
                "UPDATE images SET value=? WHERE id=?",
                JSON.stringify({ id: image.id, taskId: id, deleted: true }),
                image.id,
              );
          });
        }
        return json({ done: images.length < 100 });
      }
      if (url.pathname === "/tasks" && request.method === "POST") {
        if (
          input.provider !== "cloudflare" ||
          input.projectId != null ||
          input.branch
        )
          throw new HttpError(
            400,
            "Choose a Cloudflare task with no local project",
          );
        const requestId = identifier(input.requestId ?? crypto.randomUUID());
        let id = requestId;
        if (this.owner() !== LEGACY_OWNER) {
          // Caller IDs are idempotency keys, never globally addressable actor IDs.
          // Retain mappings after deletion: a late create retry must not resurrect a task.
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO task_creation_requests VALUES (?,?)", requestId, crypto.randomUUID());
          id = this.ctx.storage.sql.exec<{ task_id: string }>("SELECT task_id FROM task_creation_requests WHERE request_id=?", requestId).toArray()[0].task_id;
        }
        const { owner: _owner, workspaceId: _workspace, createdBy: _creator, githubAccountId: _github, ...settings } = input;
        const init = { ...settings, id, ...(this.owner() === LEGACY_OWNER ? {} : {
          workspaceId: this.workspace(), createdBy: this.owner(), githubAccountId: this.owner(),
        }) };
        const existing = this.ctx.storage.sql
          .exec<{ init: string }>("SELECT init FROM tasks WHERE id=?", id)
          .toArray()[0];
        if (existing && existing.init !== JSON.stringify(init))
          throw new HttpError(
            409,
            "Creation ID was used for different settings",
          );
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO tasks VALUES (?,-1,'{}',?)",
          id,
          JSON.stringify(init),
        );
        const task = await checked<Task>(
          await this.task(id).fetch(internal("/init", init)),
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET value=?,cursor=MAX(cursor,0) WHERE id=? AND cursor <= 0",
          JSON.stringify(task),
          id,
        );
        for (const socket of this.ctx.getWebSockets())
          this.send(socket, { type: "tasks", tasks: this.tasks() });
        return json(task);
      }
      if (url.pathname === "/claim") {
        const taskId = identifier(input.taskId);
        if (this.deleted(taskId))
          throw new HttpError(410, "This session was deleted");
        const ids = input.ids;
        if (
          !Array.isArray(ids) ||
          ids.length > MAX_IMAGES ||
          new Set(ids).size !== ids.length
        )
          throw new HttpError(400, "Attach up to six images");
        const images = ids.map((id: unknown) => {
          const image = this.image(identifier(id));
          if (!image || image.deleted)
            throw new HttpError(400, "Attachment not found; attach it again");
          if (image.taskId && image.taskId !== taskId)
            throw new HttpError(409, "Attachment belongs to another task");
          return image;
        });
        if (
          images.reduce((n, image) => n + image.size, 0) >
          MAX_MESSAGE_IMAGE_BYTES
        )
          throw new HttpError(400, "Attachments must total 10 MB or less");
        this.ctx.storage.transactionSync(() => {
          images.forEach((image) => this.putImage({ ...image, taskId }));
        });
        return json(images.map(publicImage));
      }
      if (url.pathname === "/publish") {
        const task = input.task as Task;
        const cursor = input.cursor as number;
        identifier(task.id);
        const prior = this.ctx.storage.sql
          .exec<{
            cursor: number;
            value: string;
          }>("SELECT cursor,value FROM tasks WHERE id=?", task.id)
          .toArray()[0];
        if (!prior) throw new HttpError(404, "Task has no directory entry");
        if (prior.cursor === -2) return json({ ok: true });
        if (cursor > prior.cursor) {
          this.ctx.storage.sql.exec(
            "UPDATE tasks SET cursor=?,value=? WHERE id=?",
            cursor,
            JSON.stringify(task),
            task.id,
          );
          const tasks =
            prior.value !== JSON.stringify(task) ? this.tasks() : undefined;
          for (const socket of this.ctx.getWebSockets()) {
            const peer = socket.deserializeAttachment() as Peer;
            if (peer.taskId === task.id)
              for (const event of input.events as CloudEvent[]) {
                if (event.cursor <= prior.cursor) continue;
                const pending = this.pending.get(socket);
                if (pending) {
                  if (pending.length >= 1000) {
                    socket.close(1013, "Reconnect to synchronize");
                    this.pending.delete(socket);
                    break;
                  }
                  pending.push(event);
                } else
                  this.send(socket, {
                    type: "cloud.event",
                    taskId: task.id,
                    ...event,
                  });
              }
            if (tasks) this.send(socket, { type: "tasks", tasks });
          }
        }
        return json({ ok: true });
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      return failure(error);
    }
  }
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    let generation: string | undefined;
    try {
      const auth = socket.deserializeAttachment() as Peer;
      if (auth.expiresAt && auth.expiresAt <= Date.now()) { socket.close(1008, "Sign in again"); return; }
      if (typeof data !== "string" || data.length > 4096)
        throw new HttpError(400, "Invalid socket message");
      const message = JSON.parse(data);
      if (message.type === "ping" && Number.isSafeInteger(message.id)) {
        this.send(socket, { type: "pong", id: message.id });
        return;
      }
      if (message.type === "subscribe") {
        const taskId = identifier(message.taskId);
        this.ownsTask(taskId);
        const peer: Peer = {
          expiresAt: (socket.deserializeAttachment() as Peer).expiresAt,
          taskId,
          generation: crypto.randomUUID(),
          syncing: true,
        };
        socket.serializeAttachment(peer);
        generation = peer.generation;
        this.pending.set(socket, []);
        const snapshot = await checked<
          Extract<ServerPacket, { type: "timeline" }>
        >(await this.task(taskId).fetch("https://internal/snapshot"));
        if (
          (socket.deserializeAttachment() as Peer).generation !==
          peer.generation
        )
          return;
        this.send(socket, snapshot);
        for (const event of this.pending.get(socket) ?? [])
          if (event.cursor > (snapshot.cursor ?? 0))
            this.send(socket, { type: "cloud.event", taskId, ...event });
        this.pending.delete(socket);
        socket.serializeAttachment({ ...peer, syncing: false });
      } else if (message.type === "task.read") {
        if ((socket.deserializeAttachment() as Peer).taskId !== message.taskId)
          throw new HttpError(403, "Open the task before marking it read");
        await checked(
          await this.task(message.taskId).fetch(
            internal("/read", { attentionId: message.attentionId }),
          ),
        );
      }
    } catch (error) {
      if (
        generation &&
        (socket.deserializeAttachment() as Peer).generation !== generation
      )
        return;
      if (generation) {
        this.pending.delete(socket);
        socket.serializeAttachment({
          ...socket.deserializeAttachment(),
          syncing: false,
        });
      }
      this.send(socket, {
        type: "error",
        message: publicError(error),
      });
    }
  }
  webSocketClose(socket: WebSocket) {
    this.pending.delete(socket);
    try {
      socket.close();
    } catch {}
  }
  webSocketError(socket: WebSocket) {
    this.webSocketClose(socket);
  }
}

const publicImage = ({
  taskId,
  deleted,
  ...image
}: ImageRecord): ImageAttachment => image;
function imageType(bytes: Uint8Array): ImageAttachment["mimeType"] {
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.subarray(start, end));
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (bytes.length >= 16 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "image/webp";
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  throw new HttpError(400, "Choose a PNG, JPEG, WebP, or GIF image");
}
