import { Images } from "./images.js";
import { randomUUID } from "node:crypto";
import type {
  Approval,
  ProviderInfo,
  ServerPacket,
  Task,
  TimelineItem,
  TimelineKind,
  DeliveryMode,
} from "../shared/contracts.js";
import { Store } from "./db.js";
import { adapters } from "./adapters/index.js";
import type { AdapterSession, Sink } from "./adapters/types.js";
import { thinkingOptions } from "./adapters/thinking.js";
import { parsePermissionMode } from "../shared/permissions.js";

export class Runtime {
  private sessions = new Map<string, AdapterSession>();
  private runs = new Set<string>();
  private images: Images;
  private activeTurns = new Map<string, string>();
  private interrupted = new Set<string>();
  private acceptingSteers = new Set<string>();
  private steering = new Map<string, Promise<void>>();
  private closing = false;
  private pending = new Map<
    string,
    { approval: Approval; resolve: (answer: { allow: boolean; text?: string }) => void }
  >();
  private streams = new Map<string, { taskId: string; text: string; timer?: NodeJS.Timeout }>();
  constructor(
    private store: Store,
    private providers: ProviderInfo[],
    private dataDir: string,
    private publish: (packet: ServerPacket, taskId?: string) => void,
    private onFirstMessage?: (taskId: string) => void,
  ) {
    this.images = new Images(store, dataDir);
  }
  approvals(taskId: string) {
    return [...this.pending.values()]
      .filter((p) => p.approval.taskId === taskId)
      .map((p) => p.approval);
  }
  private tasks() {
    this.publish({ type: "tasks", tasks: this.store.tasks() });
  }
  private flush(id: string) {
    const s = this.streams.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = undefined;
    this.store.patchItem(s.taskId, id, { text: s.text });
    this.publish({ type: "item.patch", taskId: s.taskId, id, patch: { text: s.text } }, s.taskId);
  }
  sink(task: Task): Sink {
    const add = (
      kind: TimelineKind,
      text: string,
      extra: { id?: string; title?: string; detail?: string; status?: TimelineItem["status"] } = {},
    ) => {
      const item = this.store.append({
        taskId: task.id,
        turnId: this.activeTurns.get(task.id),
        id: extra.id ?? randomUUID(),
        kind,
        text,
        ...extra,
      });
      this.streams.set(item.id, { taskId: task.id, text });
      this.publish({ type: "item", item }, task.id);
      return item.id;
    };
    return {
      add,
      patch: (id, patch) => {
        this.flush(id);
        const s = this.streams.get(id);
        if (s && patch.text !== undefined) s.text = patch.text;
        this.store.patchItem(task.id, id, patch);
        this.publish({ type: "item.patch", taskId: task.id, id, patch }, task.id);
      },
      delta: (id, text) => {
        const s = this.streams.get(id);
        if (!s) return;
        s.text += text;
        if (!s.timer) s.timer = setTimeout(() => this.flush(id), 40);
      },
      identity: (id) => {
        this.store.patchTask(task.id, { nativeSessionId: id });
        this.tasks();
      },
      model: (id) => {
        if (this.store.task(task.id)?.resolvedModel === id) return;
        this.store.patchTask(task.id, { resolvedModel: id });
        this.tasks();
      },
      status: (status) => {
        this.store.patchTask(task.id, { status });
        this.tasks();
      },
      ask: (title, detail, input) =>
        new Promise((resolve) => {
          const approval: Approval = { id: randomUUID(), taskId: task.id, title, detail, input };
          this.pending.set(approval.id, { approval, resolve });
          this.store.patchTask(task.id, { status: "waiting" });
          this.tasks();
          this.publish(
            { type: "approvals", taskId: task.id, approvals: this.approvals(task.id) },
            task.id,
          );
        }),
    };
  }
  private queueChanged(taskId: string) {
    this.publish({ type: "queue", taskId, queue: this.store.queue(taskId) }, taskId);
  }
  async send(
    task: Task,
    text: string,
    requestId: string,
    mode: DeliveryMode = "queue",
    imageIds: unknown = [],
  ) {
    if (this.closing) throw new Error("The server is shutting down");
    const provider = this.providers.find((p) => p.id === task.provider);
    if (!provider?.available)
      throw new Error(
        `${adapters[task.provider].name} is not ready. Check its login on the server, then refresh harnesses.`,
      );
    if (mode === "steer" && !provider.capabilities.steer)
      throw new Error("This harness does not support steering");
    const accepted = this.store.db.transaction(() => {
      if (!this.store.claimRequest(requestId, task.id)) return false;
      const images = this.images.claim(task.id, imageIds);
      if (!text.trim() && !images.length) throw new Error("Write a message or attach an image");
      this.store.enqueue({
        id: requestId,
        taskId: task.id,
        text,
        ...(images.length ? { images } : {}),
        mode,
        status: "pending",
        error: null,
        createdAt: new Date().toISOString(),
      });
      return true;
    })();
    if (!accepted) return;
    if (mode === "steer" && (!this.runs.has(task.id) || this.interrupted.has(task.id)))
      this.store.patchQueued(
        task.id,
        requestId,
        "blocked",
        "The turn has ended. Send as a new message when ready.",
      );
    this.queueChanged(task.id);
    if (mode === "steer") this.pumpSteers(task.id);
    else this.startNext(task.id);
  }
  removeQueued(taskId: string, id: string) {
    const message = this.store.queue(taskId).find((m) => m.id === id);
    if (message?.status === "sending") throw new Error("This message is already being delivered");
    this.store.removeQueued(taskId, id);
    this.queueChanged(taskId);
  }
  editQueued(
    taskId: string,
    id: string,
    text: string,
    expectedText: string,
    imageIds?: unknown,
    expectedImages?: string[],
  ) {
    this.store.db.transaction(() => {
      const images = imageIds === undefined ? undefined : this.images.claim(taskId, imageIds);
      this.store.editQueued(taskId, id, text, expectedText, images, expectedImages);
    })();
    this.queueChanged(taskId);
  }
  moveQueued(taskId: string, id: string, beforeId: string | null) {
    this.store.moveQueued(taskId, id, beforeId);
    this.queueChanged(taskId);
  }
  steerQueued(task: Task, id: string) {
    const message = this.store.queue(task.id).find((m) => m.id === id);
    if (!message || message.status === "sending") return;
    if (!this.runs.has(task.id) || this.interrupted.has(task.id))
      throw new Error("There is no active turn to steer");
    if (!this.providers.find((p) => p.id === task.provider)?.capabilities.steer)
      throw new Error("This harness does not support steering");
    this.store.patchQueued(task.id, id, "pending", null, "steer");
    this.queueChanged(task.id);
    this.pumpSteers(task.id);
  }
  resumeQueue(taskId: string) {
    if (this.runs.has(taskId)) return;
    const first = this.store.queue(taskId)[0];
    if (!first) return;
    this.store.patchQueued(taskId, first.id, "pending", null, "queue");
    this.startNext(taskId);
  }
  private startNext(taskId: string) {
    if (this.closing || this.runs.has(taskId)) return;
    const task = this.store.task(taskId);
    const message = this.store.queue(taskId)[0];
    if (!task || !message || message.mode !== "queue" || message.status !== "pending") return;
    const provider = this.providers.find((p) => p.id === task.provider);
    if (!provider?.available) return;
    const text = message.text;
    const accepted = this.store.db.transaction(() => {
      const nameTask = this.store.prepareTitle(task.id, text);
      const turn = this.store.startTurn(task.id);
      const item = this.store.append({
        id: message.id,
        taskId: task.id,
        turnId: turn.id,
        kind: "user",
        text,
        ...(message.images?.length ? { images: message.images } : {}),
        createdAt: turn.startedAt,
      });
      this.store.patchTask(task.id, {
        status: "running",
      });
      this.store.removeQueued(task.id, message.id);
      return { turn, item, nameTask };
    })();
    this.activeTurns.set(task.id, accepted.turn.id);
    this.runs.add(task.id);
    this.interrupted.delete(task.id);
    this.publish({ type: "turn", turn: accepted.turn }, task.id);
    this.publish({ type: "item", item: accepted.item }, task.id);
    this.queueChanged(task.id);
    this.tasks();
    void this.execute(task, text, provider, message.images);
    if (accepted.nameTask) this.onFirstMessage?.(task.id);
  }
  private pumpSteers(taskId: string) {
    if (this.closing || this.steering.has(taskId) || !this.acceptingSteers.has(taskId)) return;
    const message = this.store
      .queue(taskId)
      .find((m) => m.mode === "steer" && m.status === "pending");
    const turnId = this.activeTurns.get(taskId);
    if (!message || !turnId) return;
    this.store.patchQueued(taskId, message.id, "sending");
    this.queueChanged(taskId);
    const delivery = (async () => {
      try {
        const session = this.sessions.get(taskId);
        if (!session?.steer) throw new Error("This harness cannot steer the current turn");
        const images = message.images?.length
          ? await this.images.native(
              message.images,
              taskId,
              this.store.task(taskId)!.provider !== "codex",
            )
          : undefined;
        await session.steer(message.text, images);
        const item = this.store.db.transaction(() => {
          const item = this.store.append({
            id: message.id,
            taskId,
            turnId,
            kind: "user",
            text: message.text,
            ...(message.images?.length ? { images: message.images } : {}),
          });
          this.store.removeQueued(taskId, message.id);
          return item;
        })();
        this.publish({ type: "item", item }, taskId);
      } catch (error) {
        this.store.patchQueued(
          taskId,
          message.id,
          "blocked",
          error instanceof Error ? error.message : String(error),
        );
      }
      this.queueChanged(taskId);
    })();
    this.steering.set(taskId, delivery);
    void delivery.finally(() => {
      this.steering.delete(taskId);
      this.pumpSteers(taskId);
    });
  }
  setPermissions(task: Task, value: unknown) {
    const current = this.store.task(task.id)!;
    const permissionMode = parsePermissionMode(current.provider, value);
    if (this.runs.has(task.id) || current.status === "running" || current.status === "waiting")
      throw new Error("Wait for this turn to finish before changing permissions");
    if (current.permissionMode === permissionMode) return current;
    this.sessions.get(task.id)?.dispose();
    this.sessions.delete(task.id);
    this.store.patchTask(task.id, { permissionMode });
    this.tasks();
    return this.store.task(task.id)!;
  }
  setModel(task: Task, model: string) {
    if (this.runs.has(task.id))
      throw new Error("Wait for this turn to finish before changing models");
    if (task.model === model) return task;
    this.sessions.get(task.id)?.dispose();
    this.sessions.delete(task.id);
    this.store.patchTask(task.id, { model, resolvedModel: null, thinkingLevel: null });
    this.tasks();
    return this.store.task(task.id)!;
  }
  async setThinking(task: Task, thinkingLevel: string | null) {
    if (this.runs.has(task.id))
      throw new Error("Wait for this turn to finish before changing thinking level");
    const provider = this.providers.find((p) => p.id === task.provider)!;
    if (thinkingLevel !== null) {
      const options = await thinkingOptions(provider, task.cwd, task.model);
      if (!options.levels.includes(thinkingLevel))
        throw new Error("This model does not support that thinking level");
    }
    if (this.runs.has(task.id) || this.store.task(task.id)?.model !== task.model)
      throw new Error("Task changed while saving. Try again after this turn.");
    if (this.store.task(task.id)?.thinkingLevel === thinkingLevel) return this.store.task(task.id)!;
    this.sessions.get(task.id)?.dispose();
    this.sessions.delete(task.id);
    this.store.patchTask(task.id, { thinkingLevel });
    this.tasks();
    return this.store.task(task.id)!;
  }
  private async execute(
    task: Task,
    text: string,
    provider: ProviderInfo,
    images?: import("../shared/contracts.js").ImageAttachment[],
  ) {
    const sink = this.sink(task);
    try {
      let session = this.sessions.get(task.id);
      if (!session) {
        const options = await thinkingOptions(provider, task.cwd, task.model);
        if (task.thinkingLevel && !options.levels.includes(task.thinkingLevel))
          throw new Error(
            "This model does not support the selected thinking level. Choose another level or use Default.",
          );
        session = await adapters[task.provider].create({
          task: { ...task, thinkingLevel: task.thinkingLevel ?? options.defaultLevel },
          sink,
          command: provider.command,
          dataDir: this.dataDir,
        });
        this.sessions.set(task.id, session);
      }
      if (this.interrupted.has(task.id)) {
        session.dispose();
        this.sessions.delete(task.id);
        return;
      }
      const nativeImages = images?.length
        ? await this.images.native(images, task.id, task.provider !== "codex")
        : undefined;
      if (this.interrupted.has(task.id)) return;
      const run = session.run(text, nativeImages);
      this.acceptingSteers.add(task.id);
      this.pumpSteers(task.id);
      await run;
      this.acceptingSteers.delete(task.id);
      await this.steering.get(task.id);
      sink.status(this.interrupted.has(task.id) ? "interrupted" : "complete");
    } catch (error) {
      this.acceptingSteers.delete(task.id);
      if (this.interrupted.has(task.id)) sink.status("interrupted");
      else {
        sink.add("error", error instanceof Error ? error.message : String(error));
        sink.status("failed");
      }
      this.sessions.get(task.id)?.dispose();
      this.sessions.delete(task.id);
    } finally {
      this.acceptingSteers.delete(task.id);
      await this.steering.get(task.id);
      for (const message of this.store.queue(task.id))
        if (message.mode === "steer" && message.status === "pending")
          this.store.patchQueued(
            task.id,
            message.id,
            "blocked",
            "The turn ended before this message could be steered. Send it as a new message when ready.",
          );
      this.queueChanged(task.id);
      for (const [id, s] of this.streams)
        if (s.taskId === task.id) {
          this.flush(id);
          this.streams.delete(id);
        }
      const turnId = this.activeTurns.get(task.id);
      if (turnId) {
        const status = this.store.task(task.id)?.status;
        const turn = this.store.finishTurn(
          turnId,
          status === "complete" || status === "failed" ? status : "interrupted",
        );
        this.publish({ type: "turn", turn }, task.id);
        this.activeTurns.delete(task.id);
      }
      this.runs.delete(task.id);
      for (const [id, p] of this.pending)
        if (p.approval.taskId === task.id) {
          p.resolve({ allow: false });
          this.pending.delete(id);
        }
      this.publish({ type: "approvals", taskId: task.id, approvals: [] }, task.id);
      if (!this.interrupted.has(task.id) && this.store.task(task.id)?.status === "complete")
        this.startNext(task.id);
    }
  }
  async interrupt(taskId: string) {
    this.interrupted.add(taskId);
    this.acceptingSteers.delete(taskId);
    for (const [id, p] of this.pending)
      if (p.approval.taskId === taskId) {
        p.resolve({ allow: false });
        this.pending.delete(id);
      }
    const session = this.sessions.get(taskId);
    this.sessions.delete(taskId);
    this.store.patchTask(taskId, { status: "interrupted" });
    this.tasks();
    try {
      await session?.interrupt();
    } finally {
      // A new send can arrive after the old run ends but before its interrupt
      // acknowledgement. Dispose only the session we actually stopped.
      session?.dispose();
    }
  }
  answer(taskId: string, id: string, answer: { allow: boolean; text?: string }) {
    const p = this.pending.get(id);
    if (!p || p.approval.taskId !== taskId) throw new Error("This request is no longer pending");
    this.pending.delete(id);
    p.resolve(answer);
    this.store.patchTask(taskId, { status: this.approvals(taskId).length ? "waiting" : "running" });
    this.tasks();
    this.publish({ type: "approvals", taskId, approvals: this.approvals(taskId) }, taskId);
  }
  dispose() {
    this.closing = true;
    for (const id of this.runs) this.interrupted.add(id);
    for (const session of this.sessions.values()) session.dispose();
    for (const [id] of this.streams) this.flush(id);
  }
}
