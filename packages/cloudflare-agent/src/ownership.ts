import { HttpError } from "./http.js";

export const LEGACY_OWNER = "legacy";
export function ownerId(value: unknown): string {
  if (
    value === LEGACY_OWNER ||
    (typeof value === "string" && /^github-[1-9][0-9]*$/.test(value))
  )
    return value;
  throw new HttpError(403, "Invalid account");
}
export const directoryName = (owner: string) =>
  owner === LEGACY_OWNER ? "default" : ownerId(owner);
export const agentName = (owner: string, task: string) =>
  owner === LEGACY_OWNER ? task : `${ownerId(owner)}:${task}`;
export const imageKey = (owner: string, id: string) =>
  owner === LEGACY_OWNER
    ? `images/${id}`
    : `users/${ownerId(owner)}/images/${id}`;
