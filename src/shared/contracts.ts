import type { PermissionMode } from "./permissions.js";

export type ProviderId = "codex" | "claude" | "pi";
export type TaskStatus = "idle" | "running" | "waiting" | "complete" | "failed" | "interrupted";

export interface ProviderCapabilities {
  resume: boolean;
  steer: boolean;
  interrupt: boolean;
  approvals: "native" | "mode-only" | "none";
  subagents: "native" | "events" | "none";
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  command: string;
  available: boolean;
  /** Availability means installed and authenticated, not merely present on PATH. */
  readiness?: "checking" | "ready" | "missing" | "unauthenticated" | "error";
  version?: string;
  capabilities: ProviderCapabilities;
}

export interface ModelOption {
  id: string;
  label: string;
  resolvedId?: string;
  description?: string;
  thinkingLevels?: string[];
  supportsAutoMode?: boolean;
  defaultThinkingLevel?: string | null;
}
export interface ThinkingOptions {
  levels: string[];
  defaultLevel: string | null;
}
export interface ModelCatalog {
  models: ModelOption[];
  defaultModel: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  isGit: boolean;
  createdAt: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "directory" | "symlink" | "file";
}

export interface WorkspaceDiff {
  content: string;
  /** Untracked text files do not have a native Git patch. */
  newFile?: { name: string; contents: string };
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  provider: ProviderId;
  model: string | null;
  thinkingLevel: string | null;
  /** Absent on older tasks: retain their native harness settings until explicitly changed. */
  permissionMode?: PermissionMode | null;
  resolvedModel?: string | null;
  status: TaskStatus;
  attentionId: string | null;
  cwd: string;
  worktreePath: string | null;
  nativeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TimelineKind =
  | "user"
  | "assistant"
  | "thought"
  | "tool"
  | "subagent"
  | "notice"
  | "error"
  | "approval";
export interface TimelineItem {
  id: string;
  taskId: string;
  turnId?: string;
  seq: number;
  kind: TimelineKind;
  text: string;
  images?: ImageAttachment[];
  title?: string;
  status?: "running" | "complete" | "failed";
  detail?: string;
  createdAt: string;
}

export interface Turn {
  id: string;
  taskId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "complete" | "failed" | "interrupted";
}

export interface Approval {
  id: string;
  taskId: string;
  title: string;
  detail: string;
  input?: boolean;
}

export type DeliveryMode = "queue" | "steer";
export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}
export interface QueuedMessage {
  id: string;
  taskId: string;
  text: string;
  images?: ImageAttachment[];
  mode: DeliveryMode;
  status: "pending" | "sending" | "blocked";
  error: string | null;
  createdAt: string;
}

export type ServerPacket =
  | { type: "pong"; id: number }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "bootstrap"; projects: Project[]; tasks: Task[]; providers: ProviderInfo[] }
  | { type: "tasks"; tasks: Task[] }
  | {
      type: "timeline";
      taskId: string;
      items: TimelineItem[];
      turns: Turn[];
      hasOlder: boolean;
      approvals: Approval[];
      queue: QueuedMessage[];
    }
  | { type: "turn"; turn: Turn }
  | { type: "approvals"; taskId: string; approvals: Approval[] }
  | { type: "queue"; taskId: string; queue: QueuedMessage[] }
  | { type: "item"; item: TimelineItem }
  | { type: "item.patch"; taskId: string; id: string; patch: Partial<TimelineItem> }
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.ready"; terminalId: string; taskId: string }
  | { type: "terminal.exit"; terminalId: string; code: number }
  | { type: "error"; message: string };

export type ClientPacket =
  | { type: "ping"; id: number }
  | { type: "subscribe"; taskId: string }
  | { type: "task.read"; taskId: string; attentionId: string }
  | { type: "terminal.create"; taskId: string; cols: number; rows: number }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  | { type: "terminal.detach" };
