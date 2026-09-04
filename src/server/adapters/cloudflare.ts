import type { CloudflareAgentEvent, CloudflareRunRequest } from "../../shared/cloudflare-agent.js";
import { piImages } from "./images.js";
import type { AdapterContext, AdapterSession, Sink } from "./types.js";
import { cloudflareFetch, cloudflareResponseError } from "./cloudflare-client.js";

const MAX_EVENT_LINE = 1024 * 1024;

export async function createCloudflare({ task, sink, command }: AdapterContext): Promise<AdapterSession> {
  const rows = new Map<string, string>();
  let active: AbortController | undefined;
  let stopping: Promise<void> | undefined;

  const stopRemote = () => {
    stopping ??= (async () => {
      const response = await cloudflareFetch(
        command,
        `/v1/agents/${encodeURIComponent(task.id)}/interrupt`,
        { method: "POST", signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) throw await cloudflareResponseError(response);
    })();
    return stopping;
  };

  const handle = (event: CloudflareAgentEvent) => {
    if (event.type === "session") {
      sink.identity(event.sessionId);
      sink.model(event.model);
    } else if (event.type === "content.start") {
      rows.set(event.id, sink.add(event.kind, "", { status: "running" }));
    } else if (event.type === "content.delta") {
      const id = rows.get(event.id);
      if (id) sink.delta(id, event.text);
    } else if (event.type === "content.end") {
      const id = rows.get(event.id);
      if (id) sink.patch(id, { text: event.text, status: "complete" });
    } else if (event.type === "tool.start") {
      rows.set(
        event.id,
        sink.add("tool", "", {
          title: event.name,
          detail: JSON.stringify(event.input, null, 2),
          status: "running",
        }),
      );
    } else if (event.type === "tool.end") {
      const id = rows.get(event.id);
      if (id) sink.patch(id, { text: event.output, status: event.isError ? "failed" : "complete" });
    } else if (event.type === "notice") sink.add("notice", event.message);
    else if (event.type === "error") throw new Error(event.message);
  };

  async function consume(response: Response) {
    if (!response.ok) throw await cloudflareResponseError(response);
    if (!response.body) throw new Error("Cloudflare agent returned no event stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let done = false;
    for (;;) {
      const next = await reader.read();
      pending += decoder.decode(next.value, { stream: !next.done });
      if (pending.length > MAX_EVENT_LINE && !pending.includes("\n"))
        throw new Error("Cloudflare agent event exceeded the size limit");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > MAX_EVENT_LINE)
          throw new Error("Cloudflare agent event exceeded the size limit");
        const event = JSON.parse(line) as CloudflareAgentEvent;
        handle(event);
        if (event.type === "done") done = true;
      }
      if (next.done) break;
    }
    if (pending.trim()) {
      const event = JSON.parse(pending) as CloudflareAgentEvent;
      handle(event);
      if (event.type === "done") done = true;
    }
    if (!done) throw new Error("Cloudflare agent stream ended before the turn completed");
  }

  return {
    async run(text, images) {
      if (!task.model) throw new Error("Choose a model for the Cloudflare agent");
      rows.clear();
      stopping = undefined;
      const controller = new AbortController();
      active = controller;
      const request: CloudflareRunRequest = {
        text,
        model: task.model,
        thinkingLevel: task.thinkingLevel,
        ...piImages(images),
      };
      try {
        await consume(
          await cloudflareFetch(command, `/v1/agents/${encodeURIComponent(task.id)}/run`, {
            method: "POST",
            body: JSON.stringify(request),
            signal: controller.signal,
          }),
        );
      } catch (error) {
        controller.abort();
        try {
          await stopRemote();
        } catch (stopError) {
          const message = error instanceof Error ? error.message : String(error);
          const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
          throw new Error(`${message}; failed to stop the remote agent: ${stopMessage}`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        if (active === controller) active = undefined;
      }
    },
    async steer(text, images) {
      const response = await cloudflareFetch(
        command,
        `/v1/agents/${encodeURIComponent(task.id)}/steer`,
        {
          method: "POST",
          body: JSON.stringify({ text, ...piImages(images) }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw await cloudflareResponseError(response);
    },
    async interrupt() {
      active?.abort();
      await stopRemote();
    },
    async dispose() {
      const controller = active;
      controller?.abort();
      if (controller) await stopRemote();
      if (active === controller) active = undefined;
    },
  };
}
