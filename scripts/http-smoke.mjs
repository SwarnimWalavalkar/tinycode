import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import WebSocket from "ws";

const state = await mkdtemp(join(tmpdir(), "tinycode-http-"));
const token = "test-only-access-token-1234567890";
const base = "http://127.0.0.1:4739";
const fixture = join(state, "project");
await mkdir(fixture);
const fixtureGit = (args) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
fixtureGit(["init", "--initial-branch=main"]);
await writeFile(join(fixture, "hello.ts"), 'export const hello = "world";\n');
fixtureGit(["add", "hello.ts"]);
fixtureGit([
  "-c",
  "user.name=Tinycode Test",
  "-c",
  "user.email=test@localhost",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "fixture",
]);
const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TINYCODE_DATA_DIR: state,
    TINYCODE_PORT: "4739",
    TINYCODE_HOST: "127.0.0.1",
    TINYCODE_TOKEN: token,
    TINYCODE_ORIGIN: base,
    TINYCODE_ALLOWED_ORIGINS: "",
    TINYCODE_CODEX_BIN: join(state, "no-codex"),
    TINYCODE_CLAUDE_BIN: join(state, "no-claude"),
    TINYCODE_PI_BIN: join(state, "no-pi"),
    SHELL: "/bin/sh",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stderr.on("data", (d) => (log += d));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log || "Server startup timed out")), 15000);
    child.stdout.on("data", (d) => {
      if (d.toString().includes("Tinycode ·")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(log));
    });
  });
  assert.equal((await fetch(base)).status, 200, "built UI is served by Node");
  assert.equal((await fetch(base + "/api/bootstrap")).status, 401);
  assert.equal((await fetch(base + "/api/directories")).status, 401);
  assert.equal((await fetch(base + "/api/providers")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/bootstrap", {
        headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert(cookie.includes("HttpOnly"));
  assert(cookie.includes("SameSite=Strict"));
  const headers = {
    "Content-Type": "application/json",
    Origin: base,
    Cookie: cookie.split(";")[0],
  };
  assert.equal((await fetch(base + "/api/bootstrap", { headers })).status, 200);
  const api = async (path, body, method = "POST") => {
    const response = await fetch(base + "/api" + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return data;
  };
  const free = await api("/tasks", { provider: "codex" });
  const folders = await api(`/directories?path=${encodeURIComponent(fixture)}`, undefined, "GET");
  assert.equal(folders.path, await realpath(fixture));
  assert.deepEqual(folders.directories, [], "project browser lists directories, not files");
  const providers = await api("/providers", {});
  assert(providers.every((provider) => !provider.available && provider.readiness === "missing"));
  const claude = await api("/tasks", { projectId: null, provider: "claude" });
  const pi = await api("/tasks", { projectId: null, provider: "pi" });
  for (const task of [free, claude, pi]) {
    assert.equal(task.projectId, null);
    assert.equal(task.worktreePath, null);
    assert.equal(task.cwd, join(state, "workspaces", task.id));
    assert.deepEqual(await api(`/tasks/${task.id}/tree`, undefined, "GET"), []);
  }
  assert.equal((await api("/bootstrap", undefined, "GET")).projects.length, 0);
  for (const invalid of [{ projectId: "missing" }, { projectId: "" }, { branch: "no-project" }]) {
    const response = await fetch(base + "/api/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "codex", ...invalid }),
    });
    assert.equal(response.status, 400);
  }
  await writeFile(join(free.cwd, "note.txt"), "original");
  const note = await api(`/tasks/${free.id}/file?path=note.txt`, undefined, "GET");
  await api(`/tasks/${free.id}/file`, { ...note, content: "saved note" }, "PUT");
  assert.equal(await readFile(join(free.cwd, "note.txt"), "utf8"), "saved note");
  assert.deepEqual(await api(`/tasks/${pi.id}/tree`, undefined, "GET"), []);
  assert.equal((await api(`/tasks/${free.id}/git`, undefined, "GET")).isGit, false);
  const project = await api("/projects", { path: fixture });
  const branch = `tinycode-smoke-${Date.now()}`;
  const task = await api("/tasks", { projectId: project.id, provider: "codex", branch });
  assert(task.worktreePath && task.cwd === task.worktreePath);
  assert((await readFile(join(task.cwd, "hello.ts"), "utf8")).includes("world"));
  const opened = await api(`/tasks/${task.id}/file?path=hello.ts`, undefined, "GET");
  await api(
    `/tasks/${task.id}/file`,
    { ...opened, content: 'export const hello = "tinycode";\n' },
    "PUT",
  );
  const status = await api(`/tasks/${task.id}/git`, undefined, "GET");
  assert.equal(status.files[0].path, "hello.ts");
  const diff = await api(`/tasks/${task.id}/diff?path=hello.ts`, undefined, "GET");
  assert(diff.content.includes('+export const hello = "tinycode";'));
  assert(
    (await readFile(join(fixture, "hello.ts"), "utf8")).includes("world"),
    "original checkout unchanged",
  );
  const denied = await fetch(base + `/api/tasks/${task.id}/file?path=../../tinycode.db`, {
    headers,
  });
  assert.equal(denied.status, 400);
  const deniedWs = new WebSocket(base.replace("http:", "ws:") + "/socket", { origin: base });
  const wsStatus = await new Promise((resolve) => {
    deniedWs.on("unexpected-response", (_, r) => {
      resolve(r.statusCode);
      r.destroy();
    });
    deniedWs.on("error", () => {});
  });
  assert.equal(wsStatus, 403);
  const ws = new WebSocket(base.replace("http:", "ws:") + "/socket", {
    origin: base,
    headers: { Cookie: cookie.split(";")[0] },
  });
  const packet = await new Promise((resolve, reject) => {
    ws.on("message", (m) => resolve(JSON.parse(m)));
    ws.on("error", reject);
  });
  assert.equal(packet.type, "bootstrap");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Projectless terminal timed out")), 10000);
    let output = "";
    ws.on("message", async (message) => {
      const packet = JSON.parse(message);
      if (packet.type === "terminal.ready") {
        ws.send(
          JSON.stringify({
            type: "terminal.input",
            terminalId: packet.terminalId,
            data: "pwd -P\r",
          }),
        );
      }
      if (packet.type === "terminal.output") {
        output += packet.data;
        if (output.includes(await realpath(free.cwd))) {
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: "terminal.close", terminalId: packet.terminalId }));
          resolve();
        }
      }
    });
    ws.send(JSON.stringify({ type: "subscribe", taskId: free.id }));
    ws.send(JSON.stringify({ type: "terminal.create", taskId: free.id, cols: 80, rows: 24 }));
  });
  ws.close();
  console.log(
    "PASS: production UI, authenticated HTTP/WebSocket, projectless tasks for all harnesses, isolated files, real projectless PTY cwd, worktree, text edit, git status/diff, path containment",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await rm(state, { recursive: true, force: true });
}
