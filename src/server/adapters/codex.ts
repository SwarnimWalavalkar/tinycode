import { randomUUID } from "node:crypto";
import { JsonLines } from "./jsonl.js";
import { codexInput, IMAGE_FRAME_BYTES } from "./images.js";
import { textContent, type AdapterContext, type AdapterSession, type Native } from "./types.js";
import { parsePermissionMode } from "../../shared/permissions.js";

const permissionPresets = {
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only", approvalsReviewer: "user" },
  "workspace-write": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
  },
  "auto-review": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    approvalsReviewer: "user",
  },
} as const;

export async function createCodex({
  task,
  sink,
  command,
}: AdapterContext): Promise<AdapterSession> {
  if (task.permissionMode != null) parsePermissionMode("codex", task.permissionMode);
  const permissions =
    task.permissionMode == null
      ? undefined
      : permissionPresets[task.permissionMode as keyof typeof permissionPresets];
  const rpc = new JsonLines(
    command,
    ["app-server", "--listen", "stdio://"],
    task.cwd,
    IMAGE_FRAME_BYTES,
  );
  let nativeId = task.nativeSessionId ?? "";
  let turnId = "";
  let starting: Promise<void> | undefined;
  let running = false;
  let finish: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let exitError: Error | undefined;
  const items = new Map<string, string>();
  const request = (method: string, params: object) => rpc.request({ method, params });
  rpc.onExit = (error) => {
    exitError = error;
    fail?.(error);
  };
  function project(item: Native, complete: boolean) {
    const key = String(item.id ?? randomUUID());
    const kind =
      item.type === "agentMessage"
        ? "assistant"
        : item.type === "reasoning"
          ? "thought"
          : /collab|agentTool/i.test(item.type)
            ? "subagent"
            : "tool";
    const body = item.text ?? item.aggregatedOutput ?? textContent(item.summary) ?? "";
    const title =
      kind === "tool"
        ? (item.command ?? item.tool ?? item.type)
        : kind === "subagent"
          ? "Subagent activity"
          : undefined;
    const status = complete ? (item.status === "failed" ? "failed" : "complete") : "running";
    let id = items.get(key);
    if (!id) {
      id = sink.add(kind, body, {
        title,
        status,
        detail: kind === "tool" || kind === "subagent" ? JSON.stringify(item, null, 2) : undefined,
      });
      items.set(key, id);
    } else
      sink.patch(id, {
        ...(body ? { text: body } : {}),
        status,
        ...(complete && (kind === "tool" || kind === "subagent")
          ? { detail: JSON.stringify(item, null, 2) }
          : {}),
      });
  }
  rpc.onMessage = (m) => {
    const p = m.params ?? {};
    if (m.id !== undefined && m.method) {
      if (
        ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
          m.method,
        )
      ) {
        void sink
          .ask(p.reason ?? "Codex requests permission", JSON.stringify(p, null, 2))
          .then((a) => {
            rpc.send({ id: m.id, result: { decision: a.allow ? "accept" : "decline" } });
          })
          .catch(() => {});
      } else {
        sink.add(
          "notice",
          `Codex requested ${m.method}. This control is not supported in v0; the request was declined.`,
        );
        rpc.send({
          id: m.id,
          error: { code: -32601, message: "Tinycode v0 does not support this request" },
        });
      }
      return;
    }
    if (p.threadId && nativeId && p.threadId !== nativeId) return;
    if (m.method === "turn/started") turnId = p.turn?.id ?? "";
    if (m.method === "item/started" || m.method === "item/completed") {
      if (p.item && p.item.type !== "userMessage") project(p.item, m.method === "item/completed");
    }
    if (
      m.method === "item/agentMessage/delta" ||
      m.method === "item/reasoning/summaryTextDelta" ||
      m.method === "item/commandExecution/outputDelta"
    ) {
      const key = String(p.itemId);
      let id = items.get(key);
      if (!id) {
        id = sink.add(
          m.method.includes("agentMessage")
            ? "assistant"
            : m.method.includes("reasoning")
              ? "thought"
              : "tool",
          "",
          { status: "running" },
        );
        items.set(key, id);
      }
      sink.delta(id, p.delta ?? "");
    }
    if (m.method === "turn/completed") {
      running = false;
      if (p.turn?.status === "failed")
        fail?.(new Error(p.turn?.error?.message ?? "Codex turn failed"));
      else finish?.();
      turnId = "";
    }
    if (m.method === "error" && !p.willRetry)
      fail?.(new Error(p.error?.message ?? "Codex reported an error"));
  };
  try {
    await request("initialize", {
      clientInfo: { name: "tinycode", title: "Tinycode", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.send({ method: "initialized" });
    const response = await request(nativeId ? "thread/resume" : "thread/start", {
      ...(nativeId ? { threadId: nativeId } : {}),
      cwd: task.cwd,
      ...permissions,
      ...(task.model ? { model: task.model } : {}),
      ...(task.thinkingLevel ? { config: { model_reasoning_effort: task.thinkingLevel } } : {}),
    });
    if (!response?.thread?.id) throw new Error("Codex did not return a native session ID");
    if (permissions) {
      const sandbox = {
        "read-only": "readOnly",
        "workspace-write": "workspaceWrite",
        "danger-full-access": "dangerFullAccess",
      }[permissions.sandbox];
      // Older servers can ignore unknown fields. Never claim native auto review
      // is active unless the server confirms it; also catch managed-policy overrides.
      const reviewer =
        response.approvalsReviewer === "guardian_subagent"
          ? "auto_review"
          : (response.approvalsReviewer ?? "user");
      if (
        response.approvalPolicy !== permissions.approvalPolicy ||
        response.sandbox?.type !== sandbox ||
        reviewer !== permissions.approvalsReviewer
      )
        throw new Error(
          "Codex could not apply the selected permissions. Choose another mode or update Codex; server policy may restrict this mode.",
        );
    }
    nativeId = response.thread.id;
    sink.identity(nativeId);
    if (response.model) sink.model(response.model);
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
        starting = request("turn/start", {
          threadId: nativeId,
          ...(permissions
            ? {
                approvalPolicy: permissions.approvalPolicy,
                approvalsReviewer: permissions.approvalsReviewer,
              }
            : {}),
          input: codexInput(text, images),
          ...(task.thinkingLevel ? { effort: task.thinkingLevel } : {}),
        }).then((r) => {
          if (running) turnId = r.turn?.id ?? turnId;
        });
        void starting.catch(reject);
      });
    },
    async steer(text, images) {
      await starting;
      if (!running || !turnId)
        throw new Error("The Codex turn has ended. Send this as a new message.");
      await request("turn/steer", {
        threadId: nativeId,
        expectedTurnId: turnId,
        input: codexInput(text, images),
      });
    },
    async interrupt() {
      if (turnId) await request("turn/interrupt", { threadId: nativeId, turnId });
      else {
        rpc.dispose();
        finish?.();
      }
    },
    dispose() {
      running = false;
      rpc.dispose();
      finish?.();
    },
  };
}
