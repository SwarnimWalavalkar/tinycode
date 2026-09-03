import type { Task, TaskStatus } from "./contracts.js";

export const isAttentionStatus = (status: TaskStatus) =>
  status === "complete" || status === "failed" || status === "interrupted";

export function taskAttentionLabel(task: Pick<Task, "status" | "attentionId">): string | null {
  if (task.status === "waiting") return "Needs your attention";
  if (!task.attentionId) return null;
  if (task.status === "complete") return "Unread completion";
  if (task.status === "failed") return "Unread error";
  if (task.status === "interrupted") return "Task interrupted";
  return null;
}
