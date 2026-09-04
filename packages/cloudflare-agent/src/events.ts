import type { CloudflareAgentEvent } from "../../../src/shared/cloudflare-agent.js";

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value);
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { text?: string; thinking?: string };
      return item.text ?? item.thinking ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolOutput(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  return messageText((result as { content?: unknown }).content);
}

export class AgentEventProjector {
  private blocks = new Map<number, string>();
  private messageSequence = 0;

  constructor(private runId: string = crypto.randomUUID()) {}

  project(event: any): CloudflareAgentEvent[] {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.blocks.clear();
      this.messageSequence += 1;
      return [];
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (!update || !/^(text|thinking)_(start|delta|end)$/.test(update.type)) return [];
      let id = this.blocks.get(update.contentIndex);
      const output: CloudflareAgentEvent[] = [];
      if (!id) {
        id = `content:${this.runId}:${this.messageSequence}:${update.contentIndex}`;
        this.blocks.set(update.contentIndex, id);
        output.push({
          type: "content.start",
          id,
          kind: update.type.startsWith("thinking") ? "thought" : "assistant",
        });
      }
      if (update.type.endsWith("_delta"))
        output.push({ type: "content.delta", id, text: update.delta ?? "" });
      if (update.type.endsWith("_end"))
        output.push({
          type: "content.end",
          id,
          text: update.content ?? update.thinking ?? update.text ?? "",
        });
      return output;
    }
    if (event.type === "tool_execution_start")
      return [
        {
          type: "tool.start",
          id: `tool:${event.toolCallId}`,
          name: event.toolName,
          input: event.args,
        },
      ];
    if (event.type === "tool_execution_end")
      return [
        {
          type: "tool.end",
          id: `tool:${event.toolCallId}`,
          output: toolOutput(event.result),
          isError: event.isError === true,
        },
      ];
    return [];
  }
}

export function completionEvent(errorMessage?: string): CloudflareAgentEvent {
  return errorMessage
    ? { type: "error", message: errorMessage }
    : { type: "done" };
}
