import type { ModelCatalog } from "./contracts.js";

export const CLOUDFLARE_AGENT_PROTOCOL = 1;

export interface CloudflareImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface CloudflareRunRequest {
  text: string;
  model: string;
  thinkingLevel: string | null;
  images?: CloudflareImage[];
}

export interface CloudflareSteerRequest {
  text: string;
  images?: CloudflareImage[];
}

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

export interface CloudflareTitleRequest {
  prompt: string;
  model: string | null;
}

export interface CloudflareTitleResponse {
  title: string;
  model: string;
}

export type CloudflareModelCatalog = ModelCatalog;
