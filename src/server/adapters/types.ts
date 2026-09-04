import type { Task, TimelineItem, TimelineKind, TaskStatus } from "../../shared/contracts.js";
import type { NativeImage } from "../images.js";

export interface Sink {
  add(
    kind: TimelineKind,
    text: string,
    extra?: { id?: string; title?: string; detail?: string; status?: TimelineItem["status"] },
  ): string;
  patch(
    id: string,
    patch: Partial<Pick<TimelineItem, "text" | "title" | "status" | "detail">>,
  ): void;
  delta(id: string, text: string): void;
  identity(id: string): void;
  model(id: string): void;
  status(status: TaskStatus): void;
  ask(title: string, detail: string, input?: boolean): Promise<{ allow: boolean; text?: string }>;
}
export interface AdapterSession {
  run(text: string, images?: NativeImage[]): Promise<void>;
  /** Resolves when the native harness accepts the input; rejects if it cannot be delivered. */
  steer?(text: string, images?: NativeImage[]): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): void | Promise<void>;
}
export interface AdapterContext {
  task: Task;
  sink: Sink;
  command: string;
  dataDir: string;
}
export type Native = Record<string, any>;
export const textContent = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => v?.text ?? "")
      .filter(Boolean)
      .join("\n");
  return value == null ? "" : JSON.stringify(value, null, 2);
};
export const summarize = (v: Native): string =>
  v.command ?? v.file_path ?? v.path ?? v.description ?? v.pattern ?? v.query ?? "";
