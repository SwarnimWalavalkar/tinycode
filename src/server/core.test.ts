import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Store } from "./db.js";
import Database from "better-sqlite3";
import { authenticated, sameOrigin } from "./auth.js";
import { containedPath, file, saveFile, git, gitStatus, diff } from "./workspace.js";
import { createTask } from "./tasks.js";
import type { Task } from "../shared/contracts.js";

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tinycode-test-"));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
describe("workspace boundary", () => {
  it("rejects lexical escapes, external symlinks, and .git files", async () => {
    const root = await fixture();
    const work = join(root, "work");
    await mkdir(work);
    await writeFile(join(root, "outside.txt"), "outside");
    await symlink(join(root, "outside.txt"), join(work, "link"));
    await mkdir(join(work, ".git"));
    await writeFile(join(work, ".git", "config"), "git");
    await expect(containedPath(work, "../outside.txt")).rejects.toThrow("outside");
    await expect(containedPath(work, "link")).rejects.toThrow("outside");
    await expect(containedPath(work, ".git/config")).rejects.toThrow("Git internal");
  });
  it("rejects saving over a file changed by the harness", async () => {
    const root = await fixture();
    await writeFile(join(root, "code.ts"), "before");
    const original = await file(root, "code.ts");
    await writeFile(join(root, "code.ts"), "agent edit");
    await expect(saveFile(root, "code.ts", "editor edit", original.revision)).rejects.toThrow(
      "changed on disk",
    );
    expect((await file(root, "code.ts")).content).toBe("agent edit");
  });
  it("reads git status and diffs without interpreting a filename as a pathspec", async () => {
    const root = await fixture();
    await git(root, ["init"]);
    await writeFile(join(root, "[one].ts"), "before\n");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "fixture",
    ]);
    await writeFile(join(root, "[one].ts"), "after\n");
    expect((await gitStatus(root)).files).toEqual([{ path: "[one].ts", status: " M" }]);
    expect((await diff(root, "[one].ts")).content).toContain("+after");
  });
});
describe("durable UI state", () => {
  it("retains native session identity and transcripts, marks interrupted work, and pages history", async () => {
    const root = await fixture();
    const path = join(root, "state.db");
    let store = new Store(path);
    store.insertProject({
      id: "p",
      name: "project",
      path: root,
      isGit: false,
      branch: null,
      createdAt: "now",
    });
    const task: Task = {
      id: "t",
      projectId: "p",
      title: "task",
      provider: "pi",
      model: null,
      thinkingLevel: null,
      status: "waiting",
      attentionId: null,
      cwd: root,
      worktreePath: null,
      nativeSessionId: "native-session",
      createdAt: "now",
      updatedAt: "now",
    };
    store.insertTask(task);
    store.patchTask("t", {
      model: "openai-codex/gpt-5.6-luna",
      thinkingLevel: "high",
      resolvedModel: "openai-codex/gpt-5.6-luna",
    });
    for (let n = 1; n <= 250; n++)
      store.append({ id: `i${n}`, taskId: "t", kind: "assistant", text: `message ${n}` });
    expect(store.claimRequest("request", "t")).toBe(true);
    expect(store.claimRequest("request", "t")).toBe(false);
    store.db.close();
    store = new Store(path);
    expect(store.task("t")?.status).toBe("interrupted");
    expect(store.task("t")?.nativeSessionId).toBe("native-session");
    expect(store.task("t")?.model).toBe("openai-codex/gpt-5.6-luna");
    expect(store.task("t")?.thinkingLevel).toBe("high");
    expect(store.task("t")?.resolvedModel).toBe("openai-codex/gpt-5.6-luna");
    const latest = store.timeline("t");
    expect(latest.items).toHaveLength(120);
    expect(latest.items[0].seq).toBe(131);
    expect(latest.hasOlder).toBe(true);
    expect(store.timeline("t", 131).items.at(-1)?.seq).toBe(130);
    store.db.close();
  });
});
describe("projectless tasks", () => {
  it("migrates existing tasks and keeps projectless task workspaces isolated from a parent repo", async () => {
    const root = await fixture();
    const path = join(root, "state.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, branch TEXT, is_git INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, status TEXT NOT NULL, cwd TEXT NOT NULL, worktree_path TEXT, native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_model TEXT, attention_id TEXT, thinking_level TEXT);
      CREATE TABLE timeline (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', title TEXT, status TEXT, detail TEXT, created_at TEXT NOT NULL, UNIQUE(task_id, seq));
      CREATE TABLE requests (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('p', 'project', '${root.replaceAll("'", "''")}', NULL, 0, 'now');
      INSERT INTO tasks VALUES ('old', 'p', 'old task', 'pi', 'chosen-model', 'complete', '${root.replaceAll("'", "''")}', NULL, 'native', 'now', 'now', 'resolved-model', 'unread', 'high');
      INSERT INTO timeline VALUES ('i', 'old', 1, 'assistant', 'kept', NULL, NULL, NULL, 'now');
      INSERT INTO requests VALUES ('request', 'old', 'now');
    `);
    legacy.close();

    const store = new Store(path);
    expect(store.task("old")).toMatchObject({
      projectId: "p",
      nativeSessionId: "native",
      model: "chosen-model",
      resolvedModel: "resolved-model",
      thinkingLevel: "high",
      status: "complete",
      attentionId: "unread",
    });
    expect(store.claimRequest("request", "old")).toBe(false);
    expect(store.timeline("old").items[0].text).toBe("kept");
    expect(
      (store.db.pragma("table_info(tasks)") as { name: string; notnull: number }[]).find(
        (column) => column.name === "project_id",
      )?.notnull,
    ).toBe(0);

    await git(root, ["init"]);
    const task = await createTask(store, root, {
      projectId: null,
      provider: "pi",
      model: null,
      thinkingLevel: null,
      branch: null,
    });
    expect(task.projectId).toBeNull();
    expect(task.cwd).toBe(join(root, "workspaces", task.id));
    expect((await gitStatus(task.cwd, true)).isGit).toBe(false);
    await expect(diff(task.cwd, "note.txt", true)).rejects.toThrow("No Git repository");
    await writeFile(join(task.cwd, "note.txt"), "hello");
    expect((await file(task.cwd, "note.txt")).content).toBe("hello");
    await expect(
      createTask(store, root, {
        projectId: null,
        provider: "pi",
        model: null,
        thinkingLevel: null,
        branch: "not-allowed",
      }),
    ).rejects.toThrow("Worktrees require a Git project");
    await expect(
      createTask(store, root, {
        projectId: "p",
        provider: "cloudflare",
        model: "openai/gpt-5.4",
        thinkingLevel: "medium",
        branch: null,
      }),
    ).rejects.toThrow("projectless VM workspace");
    const cloudTask = await createTask(store, root, {
      projectId: null,
      provider: "cloudflare",
      model: "openai/gpt-5.4",
      thinkingLevel: "medium",
      branch: null,
    });
    expect(cloudTask).toMatchObject({ provider: "cloudflare", projectId: null });
    await git(task.cwd, ["init"]);
    expect((await gitStatus(task.cwd, true)).files).toEqual([{ path: "note.txt", status: "??" }]);
    store.db.close();

    const reopened = new Store(path);
    expect(reopened.task(task.id)?.projectId).toBeNull();
    expect(reopened.task(task.id)?.cwd).toBe(task.cwd);
    expect((await file(task.cwd, "note.txt")).content).toBe("hello");
    expect(reopened.db.pragma("foreign_key_check")).toEqual([]);
    reopened.db.close();
  });
});
describe("remote access", () => {
  const request = (headers: IncomingMessage["headers"]) => ({ headers }) as IncomingMessage;
  it("requires the exact token on HTTP and websocket requests", () => {
    const token = "test-only-access-token-123456";
    expect(authenticated(request({}), token)).toBe(false);
    expect(authenticated(request({ authorization: "Bearer wrong" }), token)).toBe(false);
    expect(authenticated(request({ authorization: `Bearer ${token}` }), token)).toBe(true);
    expect(authenticated(request({ cookie: `other=x; tinycode=${token}` }), token)).toBe(true);
  });
  it("rejects cross-origin requests and supports an explicit reverse-proxy origin", () => {
    expect(sameOrigin(request({ host: "localhost:4738", origin: "https://evil.example" }))).toBe(
      false,
    );
    expect(sameOrigin(request({ host: "localhost:4738", origin: "http://localhost:4738" }))).toBe(
      true,
    );
    expect(
      sameOrigin(
        request({ host: "internal:4738", origin: "https://tinycode.example" }),
        "https://tinycode.example",
      ),
    ).toBe(true);
  });
});
