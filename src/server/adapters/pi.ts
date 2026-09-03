import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { JsonLines } from "./jsonl.js";
import { piImages, IMAGE_FRAME_BYTES } from "./images.js";
import { textContent, type AdapterContext, type AdapterSession } from "./types.js";
import { parsePermissionMode } from "../../shared/permissions.js";

export async function createPi({
  task,
  sink,
  command,
  dataDir,
}: AdapterContext): Promise<AdapterSession> {
  if (task.permissionMode != null) parsePermissionMode("pi", task.permissionMode);
  const sessionDir = join(dataDir, "pi", task.id);
  mkdirSync(sessionDir, { recursive: true });
  const rpc = new JsonLines(
    command,
    [
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      ...(task.nativeSessionId ? ["--session", task.nativeSessionId] : []),
      ...(task.model ? ["--model", task.model] : []),
      ...(task.thinkingLevel ? ["--thinking", task.thinkingLevel] : []),
      ...(task.permissionMode === "read-only-tools" ? ["--tools", "read,grep,find,ls"] : []),
      ...(task.permissionMode === "no-tools" ? ["--no-tools"] : []),
    ],
    task.cwd,
    IMAGE_FRAME_BYTES,
  );
  let finish: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let exitError: Error | undefined;
  let running = false;
  let starting: Promise<unknown> | undefined;
  let steering: { resolve: () => void; reject: (error: Error) => void; text?: string } | undefined;
  let previousQueue: string[] = [];
  const rejectSteer = (error: Error) => {
    steering?.reject(error);
    steering = undefined;
  };
  const blocks = new Map<number, string>();
  const tools = new Map<string, string>();
  rpc.onExit = (error) => {
    exitError = error;
    running = false;
    rejectSteer(error);
    fail?.(error);
  };
  rpc.onMessage = (m) => {
    if (m.type === "queue_update" && Array.isArray(m.steering)) {
      // Pi expands templates before queuing. Match the native text, not our input.
      const remaining = [...previousQueue];
      for (const text of m.steering) {
        const index = remaining.indexOf(text);
        if (index >= 0) remaining.splice(index, 1);
        else if (steering && steering.text === undefined) steering.text = text;
      }
      previousQueue = [...m.steering];
    }
    if (
      m.type === "message_start" &&
      m.message?.role === "user" &&
      steering?.text !== undefined &&
      textContent(m.message.content) === steering.text
    ) {
      steering.resolve();
      steering = undefined;
    }
    if (m.type === "message_start" && m.message?.role === "assistant") blocks.clear();
    if (m.type === "message_update") {
      const event = m.assistantMessageEvent;
      if (event && /^(text|thinking)_(start|delta|end)$/.test(event.type)) {
        let id = blocks.get(event.contentIndex);
        if (!id) {
          id = sink.add(event.type.startsWith("thinking") ? "thought" : "assistant", "", {
            status: "running",
          });
          blocks.set(event.contentIndex, id);
        }
        if (event.type.endsWith("_delta")) sink.delta(id, event.delta ?? "");
        if (event.type.endsWith("_end"))
          sink.patch(id, { text: event.content ?? "", status: "complete" });
      }
    }
    if (m.type === "message_end" && m.message?.role === "assistant") {
      for (const [index, block] of (m.message.content ?? []).entries()) {
        if (block.type !== "text" && block.type !== "thinking") continue;
        const text = block.type === "thinking" ? (block.thinking ?? "") : (block.text ?? "");
        const status = m.message.stopReason === "error" ? "failed" : "complete";
        const id = blocks.get(index);
        if (id) sink.patch(id, { text, status });
        else sink.add(block.type === "thinking" ? "thought" : "assistant", text, { status });
      }
      if (m.message.errorMessage) fail?.(new Error(m.message.errorMessage));
      blocks.clear();
    }
    if (m.type === "tool_execution_start") {
      tools.set(
        m.toolCallId,
        sink.add(/subagent/i.test(m.toolName) ? "subagent" : "tool", "", {
          title: m.toolName,
          detail: JSON.stringify(m.args, null, 2),
          status: "running",
        }),
      );
    }
    if (m.type === "tool_execution_end") {
      const id = tools.get(m.toolCallId);
      if (id)
        sink.patch(id, {
          text: textContent(m.result?.content),
          status: m.isError ? "failed" : "complete",
        });
    }
    if (m.type === "extension_ui_request") {
      if (["confirm", "input", "select", "editor"].includes(m.method))
        void sink
          .ask(
            m.title ?? "Pi extension",
            m.message ?? textContent(m.options),
            m.method !== "confirm",
          )
          .then((a) =>
            rpc.send({
              type: "extension_ui_response",
              id: m.id,
              ...(m.method === "confirm"
                ? { confirmed: a.allow }
                : a.allow
                  ? { value: a.text ?? "" }
                  : { cancelled: true }),
            }),
          )
          .catch(() => {});
      else sink.add("notice", m.message ?? m.text ?? m.title ?? m.method);
    }
    if (m.type === "agent_end") {
      running = false;
      if (steering) {
        exitError = new Error(
          "Pi finished before consuming the steering message. Send it again when ready.",
        );
        rejectSteer(exitError);
        fail?.(exitError);
        // A late native queue entry must never spill into a later turn.
        rpc.dispose();
      }
      void rpc.request({ type: "get_state" }).then(
        (state) => {
          if (state.sessionFile) sink.identity(state.sessionFile);
          if (state.model) sink.model(`${state.model.provider}/${state.model.id}`);
        },
        () => {},
      );
      finish?.();
    }
  };
  try {
    const state = await rpc.request({ type: "get_state" });
    if (state.sessionFile) sink.identity(state.sessionFile);
    if (state.model) sink.model(`${state.model.provider}/${state.model.id}`);
  } catch (e) {
    rpc.dispose();
    throw e;
  }
  return {
    async run(text, images) {
      if (exitError) throw exitError;
      running = true;
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
        starting = rpc.request({ type: "prompt", message: text, ...piImages(images) });
        void starting.catch(reject);
      });
    },
    async steer(text, images) {
      await starting;
      if (!running) throw new Error("The Pi turn has ended. Send this as a new message.");
      const consumed = new Promise<void>((resolve, reject) => {
        steering = { resolve, reject };
      });
      // The RPC acknowledgement means queued, not consumed. Keep it visible until message_start.
      void consumed.catch(() => {});
      try {
        await rpc.request({ type: "steer", message: text, ...piImages(images) });
        await consumed;
      } catch (error) {
        rejectSteer(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    async interrupt() {
      running = false;
      rejectSteer(new Error("Task stopped before the message was consumed"));
      await rpc.request({ type: "abort" });
      finish?.();
    },
    dispose() {
      running = false;
      rejectSteer(new Error("Pi closed before the message was consumed"));
      rpc.dispose();
      finish?.();
    },
  };
}
