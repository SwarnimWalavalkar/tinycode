import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import type { ServerPacket, Task } from "../shared/contracts.js";
import {
  cloudflareAgentUrl,
  cloudflareFetch,
  cloudflareResponseError,
} from "./adapters/cloudflare-client.js";
import type { Images } from "./images.js";
import type { Store } from "./db.js";

/** A disposable proxy/cache. Cloud tasks never enter the local Runtime or Store. */
export class CloudAuthority {
  private tasks: Task[] = [];
  private sockets = new Set<WebSocket>();
  private disposed = false;
  private migration?: Promise<void>;
  private migrated = new Set<string>();
  constructor(private changed: () => void) {}
  configured() {
    return !!cloudflareAgentUrl();
  }
  owns(id: string) {
    return this.tasks.some((task) => task.id === id);
  }
  merge(local: Task[]) {
    const ids = new Set(this.tasks.map((task) => task.id));
    return [...local.filter((task) => !ids.has(task.id)), ...this.tasks].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async fetch(path: string, init: RequestInit = {}) {
    const base = cloudflareAgentUrl();
    if (!base) throw new Error("Cloudflare is not configured");
    return cloudflareFetch(base, path, {
      signal: AbortSignal.timeout(30_000),
      ...init,
    });
  }
  async refresh() {
    if (!this.configured()) return;
    const response = await this.fetch("/api/tasks");
    if (!response.ok) throw await cloudflareResponseError(response);
    this.tasks = (await response.json()) as Task[];
  }
  async create(input: unknown): Promise<Task> {
    const response = await this.fetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await cloudflareResponseError(response);
    const task = (await response.json()) as Task;
    this.tasks = [...this.tasks.filter((t) => t.id !== task.id), task];
    this.changed();
    return task;
  }
  async migrate(store: Store, images: Images) {
    if (!this.configured()) return;
    if (this.migration) return this.migration;
    this.migration = (async () => {
      for (const task of store
        .tasks()
        .filter((task) => task.provider === "cloudflare" && !this.migrated.has(task.id))) {
        if (task.status === "running" || task.status === "waiting")
          throw new Error("Stop the legacy cloud task before importing it");
        await this.create({
          requestId: task.id,
          provider: "cloudflare",
          model: task.model,
          thinkingLevel: task.thinkingLevel,
          permissionMode: task.permissionMode,
          legacy: true,
        });
        const send = async (input: unknown) => {
          const response = await this.fetch(`/api/tasks/${task.id}/import`, {
            method: "POST",
            body: JSON.stringify(input),
          });
          if (!response.ok) throw await cloudflareResponseError(response);
        };
        let before: number | undefined;
        for (;;) {
          const page = store.timeline(task.id, before);
          for (const item of page.items) {
            await this.uploadImages(
              item.images?.map((i) => i.id),
              images,
            );
            await send({ items: [item], turns: [] });
          }
          await send({ items: [], turns: page.turns });
          if (!page.hasOlder) break;
          before = page.items[0].seq;
        }
        const queue = store.queue(task.id);
        let after = "";
        for (;;) {
          const receipts = store.requestIds(task.id, after);
          if (!receipts.length) break;
          await send({ items: [], turns: [], receipts });
          after = receipts.at(-1)!;
        }
        for (const row of queue)
          await this.uploadImages(
            row.images?.map((i) => i.id),
            images,
          );
        await send({ items: [], turns: [], finish: true, task, queue });
        this.migrated.add(task.id);
      }
    })().finally(() => {
      this.migration = undefined;
    });
    return this.migration;
  }
  /** Upload local draft attachments once; accepted cloud attachments are immutable. */
  async uploadImages(ids: unknown, images: Images) {
    if (ids === undefined) return;
    if (!Array.isArray(ids) || ids.length > 6 || ids.some((id) => typeof id !== "string"))
      throw new Error("Invalid image list");
    for (const id of ids) {
      const remote = await this.fetch(`/api/images/${encodeURIComponent(id)}`);
      await remote.body?.cancel();
      if (remote.ok) continue;
      if (remote.status !== 404) throw new Error("Could not check cloud attachment");
      const image = images.get(id);
      const data = await readFile(images.path(image));
      const response = await this.fetch(
        `/api/images/${id}?name=${encodeURIComponent(image.name)}`,
        {
          method: "PUT",
          headers: { "content-type": image.mimeType },
          body: data,
        },
      );
      if (!response.ok) throw await cloudflareResponseError(response);
    }
  }
  attach(receive: (packet: ServerPacket) => void) {
    let socket: WebSocket | undefined;
    let subscribed: string | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed || this.disposed || !this.configured()) return;
      const url = new URL(`${cloudflareAgentUrl()}/socket`);
      url.protocol = "wss:";
      socket = new WebSocket(url, ["tinycode"], {
        headers: {
          authorization: `Bearer ${process.env.TINYCODE_CLOUDFLARE_AGENT_TOKEN ?? ""}`,
        },
      });
      const current = socket;
      this.sockets.add(current);
      current.on("open", () => {
        if (subscribed) current.send(JSON.stringify({ type: "subscribe", taskId: subscribed }));
      });
      current.on("message", (data) => {
        try {
          const packet = JSON.parse(data.toString()) as ServerPacket;
          if (packet.type === "bootstrap" || packet.type === "tasks") {
            this.tasks = packet.tasks;
            this.changed();
          } else if (packet.type !== "providers" && packet.type !== "pong") receive(packet);
        } catch {
          current.close(1011, "Invalid cloud response");
        }
      });
      current.on("error", () => {});
      current.on("close", () => {
        this.sockets.delete(current);
        if (!closed && !this.disposed) retry = setTimeout(connect, 2000);
      });
    };
    connect();
    return {
      send: (packet: { type: string; taskId?: string; [key: string]: unknown }) => {
        if (packet.type === "subscribe") subscribed = packet.taskId;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
      },
      close: () => {
        closed = true;
        clearTimeout(retry);
        socket?.close();
      },
    };
  }
  dispose() {
    this.disposed = true;
    for (const socket of this.sockets) socket.close();
  }
}
