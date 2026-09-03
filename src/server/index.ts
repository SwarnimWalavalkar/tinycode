import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { realpath, stat, mkdir, readFile } from "node:fs/promises";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";
import { TaskTitles } from "./titles.js";
import { Images, imageBody } from "./images.js";
import { Terminals } from "./terminals.js";
import { createTask } from "./tasks.js";
import { adapters, probeProviders } from "./adapters/index.js";
import { modelCatalog } from "./adapters/models.js";
import { thinkingOptions } from "./adapters/thinking.js";
import { diff, file, gitInfo, gitStatus, saveFile, tree } from "./workspace.js";
import {
  authenticated,
  sameOrigin,
  tokenMatches,
  unauthenticatedHostAllowed,
  websocketAuthenticated,
} from "./auth.js";
import { developmentOrigin } from "./dev-network.js";
import type { ClientPacket, ProviderId, ServerPacket } from "../shared/contracts.js";

const host = process.env.TINYCODE_HOST ?? "127.0.0.1";
const port = Number(process.env.TINYCODE_PORT ?? 4738);
const token = process.env.TINYCODE_TOKEN;
const origin = process.env.TINYCODE_ORIGIN;
const devOrigin = developmentOrigin();
const allowedOrigins = (process.env.TINYCODE_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw new Error("TINYCODE_ALLOWED_ORIGINS must contain HTTP(S) origins without paths");
    return url.origin;
  });
if (allowedOrigins.length && (!token || token.length < 24))
  throw new Error("Separate frontend origins require TINYCODE_TOKEN with at least 24 characters");
if (!["127.0.0.1", "localhost", "::1"].includes(host) && (!token || token.length < 24))
  throw new Error("Remote listeners require TINYCODE_TOKEN with at least 24 characters");
const dataDir = resolve(process.env.TINYCODE_DATA_DIR ?? join(homedir(), ".tinycode"));
const store = new Store(join(dataDir, "tinycode.db"));
const images = new Images(store, dataDir);
await images.prune();
const workspacesDir = join(dataDir, "workspaces");
await mkdir(workspacesDir, { recursive: true });
const providers = await probeProviders();
const peers = new Map<
  WebSocket,
  { taskId?: string; terminalId?: string; send: (p: ServerPacket) => void }
>();
const publish = (packet: ServerPacket, taskId?: string) => {
  for (const peer of peers.values()) if (!taskId || peer.taskId === taskId) peer.send(packet);
};
const titles = new TaskTitles(store, providers, publish);
const runtime = new Runtime(store, providers, dataDir, publish, (id) => void titles.start(id));
titles.recover();
const terminals = new Terminals();
const bootstrap = (): ServerPacket => ({
  type: "bootstrap",
  projects: store.projects(),
  tasks: store.tasks(),
  providers,
});
const findTask = (id: string) => {
  const task = store.task(id);
  if (!task) throw new Error("Task not found");
  return task;
};
const string = (v: unknown, max = 4096) => {
  if (typeof v !== "string" || v.length > max) throw new Error("Invalid text field");
  return v;
};
const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    res.setHeader("Vary", "Origin");
    if (!sameOrigin(req, origin, allowedOrigins)) {
      json(res, { error: "Origin is not allowed" }, 403);
      return;
    }
    if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204);
      res.end();
      return;
    }
    // An explicitly configured dev proxy can carry its public hostname to
    // the loopback backend. Other unauthenticated hosts are rejected.
    if (!token && !unauthenticatedHostAllowed(req, devOrigin)) {
      json(res, { error: "Unexpected host" }, 403);
      return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const input = await body(req);
      if (!token || !tokenMatches(string(input.token), token)) {
        json(res, { error: "Invalid access token" }, 401);
        return;
      }
      res.setHeader(
        "Set-Cookie",
        `tinycode=${token}; HttpOnly; SameSite=Strict; Path=/${origin?.startsWith("https:") ? "; Secure" : ""}`,
      );
      json(res, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/") && !authenticated(req, token)) {
      json(res, { error: "Enter this server's access token", authRequired: true }, 401);
      return;
    }
    const imageMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/);
    if (imageMatch) {
      const id = imageMatch[1];
      if (req.method === "PUT") {
        json(
          res,
          await images.save(
            id,
            url.searchParams.get("name") ?? "Image",
            req.headers["content-type"]?.split(";")[0] ?? "",
            await imageBody(req),
          ),
        );
        return;
      }
      if (req.method === "GET") {
        const image = images.get(id);
        res.setHeader("Vary", "Origin, Authorization, Cookie");
        res.setHeader("Content-Type", image.mimeType);
        res.setHeader("Cache-Control", "private, max-age=86400, immutable");
        res.end(await readFile(images.path(image)));
        return;
      }
      if (req.method === "DELETE") {
        await images.remove(id);
        json(res, { ok: true });
        return;
      }
    }
    if (url.pathname === "/api/bootstrap") {
      json(res, bootstrap());
      return;
    }
    if (["/api/models", "/api/thinking"].includes(url.pathname) && req.method === "GET") {
      const provider = providers.find((p) => p.id === url.searchParams.get("provider"));
      if (!provider) throw new Error("Unknown harness");
      const projectId = url.searchParams.get("projectId");
      const taskId = url.searchParams.get("taskId");
      const cwd = taskId
        ? findTask(taskId).cwd
        : projectId
          ? store.project(projectId)?.path
          : workspacesDir;
      if (!cwd) throw new Error("Project not found");
      json(
        res,
        url.pathname === "/api/thinking"
          ? await thinkingOptions(provider, cwd, url.searchParams.get("model"))
          : await modelCatalog(provider, cwd),
      );
      return;
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      const input = await body(req);
      let path = string(input.path);
      if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
      path = await realpath(resolve(path));
      if (!(await stat(path)).isDirectory()) throw new Error("Choose a directory on the server");
      let project = store.projects().find((p) => p.path === path);
      if (!project) {
        project = {
          id: randomUUID(),
          name: basename(path),
          path,
          ...(await gitInfo(path)),
          createdAt: new Date().toISOString(),
        };
        store.insertProject(project);
      }
      publish(bootstrap());
      json(res, project);
      return;
    }
    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const input = await body(req);
      const provider = string(input.provider) as ProviderId;
      if (!Object.hasOwn(adapters, provider)) throw new Error("Unknown harness");
      const task = await createTask(store, dataDir, {
        projectId: input.projectId == null ? null : string(input.projectId),
        provider,
        model: input.model ? string(input.model, 200) : null,
        thinkingLevel: input.thinkingLevel ? string(input.thinkingLevel, 32) : null,
        permissionMode: input.permissionMode,
        branch: input.branch ? string(input.branch, 150) : null,
      });
      publish({ type: "tasks", tasks: store.tasks() });
      json(res, task);
      return;
    }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const task = findTask(match[1]);
      const action = match[2];
      if (action === "title" && req.method === "POST") {
        const input = await body(req);
        json(res, titles.rename(task.id, string(input.title, 80)));
        return;
      }
      if (action === "title/suggest" && req.method === "POST") {
        json(res, await titles.suggest(task.id));
        return;
      }
      if (action === "permissions" && req.method === "POST") {
        const input = await body(req);
        json(res, runtime.setPermissions(task, input.permissionMode));
        return;
      }
      if (action === "thinking" && req.method === "POST") {
        const input = await body(req);
        const level = input.thinkingLevel === null ? null : string(input.thinkingLevel, 32);
        json(res, await runtime.setThinking(task, level));
        return;
      }
      if (action === "model" && req.method === "POST") {
        const input = await body(req);
        const model = string(input.model, 200).trim();
        if (!model) throw new Error("Choose a model");
        json(res, runtime.setModel(task, model));
        return;
      }
      if (action === "send" && req.method === "POST") {
        const input = await body(req);
        const text = string(input.text ?? "", 100000).trim();
        const mode = input.mode ?? "queue";
        if (mode !== "queue" && mode !== "steer") throw new Error("Choose Queue or Steer");
        await runtime.send(task, text, string(input.requestId, 100), mode, input.images);
        json(res, { ok: true });
        return;
      }
      if (action === "queue/resume" && req.method === "POST") {
        runtime.resumeQueue(task.id);
        json(res, { ok: true });
        return;
      }
      if (action === "queue/edit" && req.method === "POST") {
        const input = await body(req);
        if (input.expectedImages !== undefined && !Array.isArray(input.expectedImages))
          throw new Error("Invalid image list");
        runtime.editQueued(
          task.id,
          string(input.id, 100),
          string(input.text, 100000),
          string(input.expectedText, 100000),
          input.images,
          input.expectedImages?.map((id: unknown) => string(id, 100)),
        );
        json(res, { ok: true });
        return;
      }
      if (action === "queue/move" && req.method === "POST") {
        const input = await body(req);
        runtime.moveQueued(
          task.id,
          string(input.id, 100),
          input.beforeId === null ? null : string(input.beforeId, 100),
        );
        json(res, { ok: true });
        return;
      }
      if ((action === "queue/remove" || action === "queue/steer") && req.method === "POST") {
        const input = await body(req);
        if (action === "queue/remove") runtime.removeQueued(task.id, string(input.id, 100));
        else runtime.steerQueued(task, string(input.id, 100));
        json(res, { ok: true });
        return;
      }
      if (action === "interrupt" && req.method === "POST") {
        await runtime.interrupt(task.id);
        json(res, { ok: true });
        return;
      }
      if (action === "answer" && req.method === "POST") {
        const input = await body(req);
        if (typeof input.allow !== "boolean") throw new Error("Invalid answer");
        runtime.answer(task.id, string(input.id), {
          allow: input.allow,
          ...(input.text !== undefined ? { text: string(input.text, 10000) } : {}),
        });
        json(res, { ok: true });
        return;
      }
      if (action === "timeline") {
        const before = Number(url.searchParams.get("before"));
        json(res, store.timeline(task.id, before || undefined));
        return;
      }
      if (action === "tree") {
        json(res, await tree(task.cwd, url.searchParams.get("path") ?? ""));
        return;
      }
      if (action === "file") {
        if (req.method === "PUT") {
          const input = await body(req);
          json(
            res,
            await saveFile(
              task.cwd,
              string(input.path),
              string(input.content, 1024 * 1024),
              string(input.revision),
            ),
          );
        } else json(res, await file(task.cwd, url.searchParams.get("path") ?? ""));
        return;
      }
      if (action === "git") {
        json(res, await gitStatus(task.cwd, task.projectId === null));
        return;
      }
      if (action === "diff") {
        json(
          res,
          await diff(task.cwd, url.searchParams.get("path") ?? "", task.projectId === null),
        );
        return;
      }
    }
    if (url.pathname.startsWith("/api/")) {
      json(res, { error: "Not found" }, 404);
      return;
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "dist");
    const asset = resolve(root, "." + decodeURIComponent(url.pathname));
    if (!asset.startsWith(root + "/") && asset !== root) {
      json(res, { error: "Not found" }, 404);
      return;
    }
    const mime: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    if (url.pathname.startsWith("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Type", mime[extname(asset)] ?? "application/octet-stream");
      res.end(await readFile(asset));
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await readFile(join(root, "index.html")));
    }
  } catch (error) {
    json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024,
  handleProtocols: (protocols) => (protocols.has("tinycode") ? "tinycode" : false),
});
server.on("upgrade", (req, socket, head) => {
  if (
    req.url !== "/socket" ||
    !sameOrigin(req, origin, allowedOrigins) ||
    !websocketAuthenticated(req, token) ||
    (!token && !unauthenticatedHostAllowed(req, devOrigin))
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
const size = (n: unknown) => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 500)
    throw new Error("Invalid terminal dimensions");
  return n;
};
wss.on("connection", (ws) => {
  const send = (packet: ServerPacket) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.close(1013, "Reconnect to resynchronize");
      return;
    }
    ws.send(JSON.stringify(packet));
  };
  const peer: { taskId?: string; terminalId?: string; send: typeof send } = { send };
  peers.set(ws, peer);
  send(bootstrap());
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as ClientPacket;
      if (message.type === "ping" && Number.isSafeInteger(message.id)) {
        send({ type: "pong", id: message.id });
        return;
      }
      if (message.type === "subscribe") {
        const task = findTask(string(message.taskId));
        peer.taskId = task.id;
        send({
          type: "timeline",
          taskId: task.id,
          ...store.timeline(task.id),
          approvals: runtime.approvals(task.id),
          queue: store.queue(task.id),
        });
      }
      if (message.type === "terminal.detach") {
        terminals.detach(send);
        peer.terminalId = undefined;
      }
      if (message.type === "task.read") {
        if (message.taskId !== peer.taskId) throw new Error("Open the task before marking it read");
        if (store.markTaskRead(string(message.taskId), string(message.attentionId, 100)))
          publish({ type: "tasks", tasks: store.tasks() });
      }
      if (message.type === "terminal.create")
        peer.terminalId = terminals.attach(
          findTask(string(message.taskId)),
          size(message.cols),
          size(message.rows),
          send,
        );
      if ("terminalId" in message && message.terminalId !== peer.terminalId)
        throw new Error("Terminal is not attached");
      if (message.type === "terminal.input")
        terminals.input(message.terminalId, string(message.data, 64000));
      if (message.type === "terminal.resize")
        terminals.resize(message.terminalId, size(message.cols), size(message.rows));
      if (message.type === "terminal.close") terminals.close(message.terminalId);
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
  ws.on("close", () => {
    peers.delete(ws);
    terminals.detach(send);
  });
  ws.on("error", () => {});
});
server.listen(port, host, () => {
  console.log(`Tinycode · http://${host}:${port} · ${dataDir}`);
  if (devOrigin) console.log(`Development URL · ${devOrigin}/`);
});
function shutdown() {
  void titles.dispose();
  runtime.dispose();
  terminals.dispose();
  for (const ws of peers.keys()) ws.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
