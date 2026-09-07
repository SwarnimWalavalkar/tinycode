import type { ModelCatalog } from "./contracts.js";

export const CLOUDFLARE_AGENT_PROTOCOL = 2;

export type CloudflareAgentEvent =
  | { type: "session"; sessionId: string; model: string }
  | { type: "content.start"; id: string; kind: "assistant" | "thought" }
  | { type: "content.delta"; id: string; text: string }
  | { type: "content.end"; id: string; text: string }
  | { type: "tool.start"; id: string; name: string; input: unknown }
  | { type: "tool.end"; id: string; output: string; isError: boolean }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface CloudflareHealth {
  ok: boolean;
  ready: boolean;
  version: string;
  protocol: number;
}

export type CloudflareModelCatalog = ModelCatalog;
