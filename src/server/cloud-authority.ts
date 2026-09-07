import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import type { ServerPacket, Task } from "../shared/contracts.js";
import {
  cloudflareAgentUrl,
  cloudflareFetch,
  cloudflareResponseError,
} from "./adapters/cloudflare-client.js";
import type { Images } from "./images.js";

/** A disposable proxy/cache. Cloud tasks never enter the local Runtime or Store. */
export class CloudAuthority {
  private tasks: Task[] = [];
  private sockets = new Set<WebSocket>();
  private disposed = false;
  constructor(private changed: () => void) {}
  configured() {
    try {
      return !!cloudflareAgentUrl();
    } catch {
      return false;
    }
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
    const pendingReads = new Map<
      string,
      { type: string; taskId?: string; [key: string]: unknown }
    >();
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
        const read = subscribed ? pendingReads.get(subscribed) : undefined;
        if (read) current.send(JSON.stringify(read));
      });
      current.on("message", (data) => {
        try {
          const packet = JSON.parse(data.toString()) as ServerPacket;
          if (packet.type === "timeline") {
            const read = pendingReads.get(packet.taskId);
            if (read) current.send(JSON.stringify(read));
          }
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
        if (packet.type === "task.read" && packet.taskId) {
          // One receipt per currently opened task; replay after reconnect/snapshot.
          pendingReads.clear();
          pendingReads.set(packet.taskId, packet);
        }
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
