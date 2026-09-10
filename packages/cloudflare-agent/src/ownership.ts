import { HttpError } from "./http.js";

export const LEGACY_OWNER = "legacy";
export function ownerId(value: unknown): string {
  if (value === LEGACY_OWNER || (typeof value === "string" && /^github-[1-9][0-9]*$/.test(value))) return value;
  throw new HttpError(403, "Invalid account");
}
export const personalWorkspace = (user: string) => user === LEGACY_OWNER ? "default" : `personal-${ownerId(user)}`;
export function workspaceId(value: unknown): string {
  if (value === "default" || (typeof value === "string" && /^personal-github-[1-9][0-9]*$/.test(value))) return value;
  throw new HttpError(403, "Invalid workspace");
}
export const directoryName = (workspace: string) => workspaceId(workspace);
export const agentName = (workspace: string, task: string) => workspace === "default" ? task : `task:${task}`;
export const imageKey = (workspace: string, id: string) => workspace === "default" ? `images/${id}` : `workspaces/${workspaceId(workspace)}/images/${id}`;
export interface TaskOwnership {
  workspaceId: string;
  createdBy: string;
  githubAccountId: string;
}
