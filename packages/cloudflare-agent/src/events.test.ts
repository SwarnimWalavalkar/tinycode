import { describe, expect, it } from "vitest";
import { AgentEventProjector, completionEvent } from "./events.js";

describe("Pi event projection", () => {
  it("keeps content identities separate across tool-driven assistant messages", () => {
    const projector = new AgentEventProjector("run");
    const events = [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "first" },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "vm_exec",
        args: { command: "pwd" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "/workspace" }] },
        isError: false,
      },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "second" },
      },
    ];
    const output = events.flatMap((event) => projector.project(event));
    const starts = output.filter((event) => event.type === "content.start");

    expect(starts).toHaveLength(2);
    expect(starts[0].id).not.toBe(starts[1].id);
    expect(output.map((event) => event.type)).toEqual([
      "content.start",
      "content.delta",
      "content.end",
      "tool.start",
      "tool.end",
      "content.start",
      "content.delta",
      "content.end",
    ]);
  });

  it("reserves done for successful Pi completion", () => {
    expect(completionEvent()).toEqual({ type: "done" });
    expect(completionEvent("provider failed")).toEqual({
      type: "error",
      message: "provider failed",
    });
  });
});
