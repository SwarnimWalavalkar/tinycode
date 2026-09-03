import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Task } from "../shared/contracts.js";
import type { Store } from "./db.js";
import { git } from "./workspace.js";
import { defaultPermissionMode, parsePermissionMode } from "../shared/permissions.js";

export async function createTask(
  store: Store,
  dataDir: string,
  input: Pick<Task, "projectId" | "provider" | "model" | "thinkingLevel"> & {
    branch: string | null;
    permissionMode?: unknown;
  },
): Promise<Task> {
  const permissionMode = parsePermissionMode(
    input.provider,
    input.permissionMode ?? defaultPermissionMode[input.provider],
  );
  const project = input.projectId === null ? null : store.project(input.projectId);
  if (input.projectId !== null && !project) throw new Error("Project not found");
  if (input.branch && !project?.isGit)
    throw new Error("Worktrees require a Git project with a commit");

  const id = randomUUID();
  let cwd = project?.path ?? join(dataDir, "workspaces", id);
  let worktreePath: string | null = null;
  if (input.branch && project) {
    await git(project.path, ["check-ref-format", "--branch", input.branch]);
    worktreePath = join(dataDir, "worktrees", id);
    await mkdir(dirname(worktreePath), { recursive: true });
    await git(project.path, ["worktree", "add", "-b", input.branch, worktreePath, "HEAD"]);
    cwd = worktreePath;
  } else if (!project) {
    await mkdir(cwd, { recursive: true });
  }

  const now = new Date().toISOString();
  const task: Task = {
    id,
    projectId: project?.id ?? null,
    title: "New task",
    provider: input.provider,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    permissionMode,
    status: "idle",
    attentionId: null,
    cwd,
    worktreePath,
    nativeSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  store.insertTask(task);
  return task;
}
