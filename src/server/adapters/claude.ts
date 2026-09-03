import {
  query,
  type Query,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  summarize,
  textContent,
  type AdapterContext,
  type AdapterSession,
  type Native,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { claudeInput } from "./images.js";
import type { NativeImage } from "../images.js";
import { parsePermissionMode } from "../../shared/permissions.js";

export async function createClaude({
  task,
  sink,
  command,
}: AdapterContext): Promise<AdapterSession> {
  if (task.permissionMode != null) parsePermissionMode("claude", task.permissionMode);
  let nativeId = task.nativeSessionId ?? undefined;
  let active: Query | undefined;
  let abort: AbortController | undefined;
  let pushInput: ((text: string, images?: NativeImage[]) => Promise<void>) | undefined;
  let closeInput: (() => void) | undefined;
  return {
    async run(text, images) {
      abort = new AbortController();
      const blocks = new Map<string, string>();
      let prefix = "";
      let wake: (() => void) | undefined;
      let closed = false;
      let releasePrompt!: () => void;
      const ready = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      const inputs: {
        content: SDKUserMessage["message"]["content"];
        resolve: () => void;
        reject: (error: Error) => void;
      }[] = [];
      closeInput = () => {
        closed = true;
        releasePrompt();
        pushInput = undefined;
        for (const input of inputs.splice(0))
          input.reject(new Error("Claude closed before accepting this message"));
        wake?.();
      };
      pushInput = (text, images) =>
        new Promise<void>((resolve, reject) => {
          inputs.push({ content: claudeInput(text, images), resolve, reject });
          wake?.();
        });
      // Keep the SDK's input stream open for permissions and native steering.
      const prompt: AsyncIterable<SDKUserMessage> = {
        async *[Symbol.asyncIterator]() {
          await ready;
          if (closed) return;
          yield {
            type: "user",
            message: { role: "user", content: claudeInput(text, images) },
            parent_tool_use_id: null,
            session_id: nativeId ?? "",
          };
          while (!closed) {
            if (!inputs.length)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            wake = undefined;
            if (closed) break;
            const input = inputs.shift();
            if (!input) continue;
            input.resolve();
            yield {
              type: "user",
              message: { role: "user", content: input.content },
              parent_tool_use_id: null,
              session_id: nativeId ?? "",
              uuid: randomUUID(),
            };
          }
        },
      };
      active = query({
        prompt,
        options: {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key !== "TINYCODE_TOKEN"),
          ),
          cwd: task.cwd,
          ...(task.permissionMode
            ? { permissionMode: task.permissionMode as Options["permissionMode"] }
            : {}),
          ...(task.permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          pathToClaudeCodeExecutable: command,
          ...(task.model ? { model: task.model } : {}),
          ...(task.thinkingLevel ? { effort: task.thinkingLevel as Options["effort"] } : {}),
          ...(nativeId ? { resume: nativeId } : {}),
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          abortController: abort,
          canUseTool: async (name, input) => {
            const answer = await sink.ask(
              `Allow ${name}?`,
              JSON.stringify(input, null, 2),
              name === "AskUserQuestion",
            );
            if (!answer.allow)
              return { behavior: "deny", message: "The user declined this request." };
            if (name === "AskUserQuestion") {
              const questions = Array.isArray(input.questions) ? input.questions : [];
              return {
                behavior: "allow",
                updatedInput: {
                  ...input,
                  answers: Object.fromEntries(
                    questions.map((q: Native) => [q.question, answer.text ?? ""]),
                  ),
                },
              };
            }
            return { behavior: "allow", updatedInput: input };
          },
        },
      });
      let resultSeen = false;
      try {
        // Claude can silently start in manual mode when auto is unavailable.
        // Its control request validates model/account policy before any prompt.
        if (task.permissionMode === "auto") await active.setPermissionMode("auto");
        releasePrompt();
        for await (const raw of active) {
          const m = raw as Native;
          if (
            m.type === "system" &&
            m.subtype === "init" &&
            task.permissionMode &&
            m.permissionMode !== task.permissionMode
          )
            throw new Error(
              "Claude Code could not apply the selected permissions. Choose another mode; auto mode depends on model availability and server policy.",
            );
          if (m.type === "system" && m.subtype === "init" && m.model) sink.model(m.model);
          if (m.session_id && m.session_id !== nativeId) {
            nativeId = m.session_id;
            sink.identity(nativeId!);
          }
          if (m.type === "stream_event") {
            const e = m.event;
            if (e.type === "message_start") prefix = e.message.id;
            const key = `${m.parent_tool_use_id ?? ""}:${prefix}:${e.index}`;
            if (e.type === "content_block_start") {
              const b = e.content_block;
              if (b.type === "text" || b.type === "thinking")
                blocks.set(
                  key,
                  sink.add(b.type === "text" ? "assistant" : "thought", b.text ?? "", {
                    status: "running",
                  }),
                );
            }
            if (e.type === "content_block_delta") {
              const id = blocks.get(key);
              if (id) sink.delta(id, e.delta.text ?? e.delta.thinking ?? "");
            }
            if (e.type === "content_block_stop") {
              const id = blocks.get(key);
              if (id) sink.patch(id, { status: "complete" });
            }
          }
          if (m.type === "assistant") {
            for (const b of m.message?.content ?? []) {
              if (b.type === "tool_use") {
                const id = sink.add(
                  ["Agent", "Task"].includes(b.name) ? "subagent" : "tool",
                  summarize(b.input ?? {}),
                  { title: b.name, detail: JSON.stringify(b.input, null, 2), status: "running" },
                );
                blocks.set(b.id, id);
              }
            }
          }
          if (m.type === "user")
            for (const b of m.message?.content ?? [])
              if (b.type === "tool_result") {
                const id = blocks.get(b.tool_use_id);
                if (id)
                  sink.patch(id, {
                    text: textContent(b.content),
                    status: b.is_error ? "failed" : "complete",
                  });
              }
          if (
            m.type === "system" &&
            ["task_started", "task_progress", "task_notification"].includes(m.subtype)
          ) {
            sink.add("subagent", m.description ?? m.summary ?? m.status ?? "", {
              title: m.subtype.replaceAll("_", " "),
              detail: JSON.stringify(m, null, 2),
              status:
                m.status === "failed"
                  ? "failed"
                  : m.subtype === "task_notification"
                    ? "complete"
                    : "running",
            });
          }
          if (m.type === "result") {
            // Claude may consume live input in a continuation. Keep that query open
            // while it reports pending user sends, including coalesced inputs.
            if (m.queued_turn_count > 0) {
              resultSeen = false;
              continue;
            }
            resultSeen = true;
            closeInput?.();
            if (m.is_error)
              throw new Error(textContent(m.errors) || m.result || "Claude Code turn failed");
            break;
          }
        }
        if (!resultSeen && !abort.signal.aborted)
          throw new Error("Claude Code closed without a turn result");
      } finally {
        closeInput?.();
        active.close();
        active = undefined;
      }
    },
    async steer(text, images) {
      if (!active || !pushInput)
        throw new Error("The Claude turn has ended. Send this as a new message.");
      await pushInput(text, images);
    },
    async interrupt() {
      closeInput?.();
      abort?.abort();
      active?.close();
    },
    dispose() {
      closeInput?.();
      abort?.abort();
      active?.close();
    },
  };
}
