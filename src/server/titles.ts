import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInfo, ServerPacket, Task } from "../shared/contracts.js";
import { titlePrompt, type TitleMessage, type TitleSuggestion } from "../shared/titles.js";
import { adapters } from "./adapters/index.js";
import { Store } from "./db.js";

/** Small, ephemeral naming requests never join the task's native session. */
export class TaskTitles {
  private requests = new Map<string, Promise<TitleSuggestion>>();
  private automatic = new Map<string, Promise<void>>();
  private controllers = new Set<AbortController>();
  private closing = false;
  constructor(
    private store: Store,
    private providers: ProviderInfo[],
    private publish: (packet: ServerPacket) => void,
  ) {}
  recover() {
    for (const { id } of this.store.pendingTitles()) void this.start(id);
  }
  start(id: string): Promise<void> {
    const existing = this.automatic.get(id);
    if (existing) return existing;
    const state = this.store.titleState(id);
    const task = this.store.task(id);
    if (this.closing || !task || state?.state !== "pending") return Promise.resolve();
    const job = this.generate(`auto:${id}`, task, this.store.titleMessages(id, true))
      .then(({ title }) => {
        if (!this.closing && this.store.applyTitle(id, title, state.revision)) this.changed();
      })
      .catch(() => {
        // Keep the provisional name if the harness is unavailable. Manual suggestions can retry.
        if (!this.closing) this.store.failTitle(id, state.revision);
      })
      .finally(() => this.automatic.delete(id));
    this.automatic.set(id, job);
    return job;
  }
  suggest(id: string) {
    const task = this.store.task(id);
    if (!task) throw new Error("Task not found");
    const messages = this.store.titleMessages(id);
    return this.generate(`suggest:${id}:${task.model}:${messages.at(-1)?.seq}`, task, messages);
  }
  rename(id: string, title: string) {
    const task = this.store.renameTask(id, title);
    this.changed();
    return task;
  }
  private changed() {
    this.publish({ type: "tasks", tasks: this.store.tasks() });
  }
  private generate(key: string, task: Task, messages: TitleMessage[]): Promise<TitleSuggestion> {
    const existing = this.requests.get(key);
    if (existing) return existing;
    if (this.closing) return Promise.reject(new Error("Server is stopping"));
    if (!messages.length)
      return Promise.reject(new Error("Send a message to get a name suggestion"));
    const provider = this.providers.find((p) => p.id === task.provider);
    if (!provider?.available)
      return Promise.reject(new Error("This harness is unavailable for name suggestions"));
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 45000);
    const request = (async () => {
      const cwd = await mkdtemp(join(tmpdir(), "tinycode-title-"));
      try {
        return await adapters[task.provider].generateTitle({
          command: provider.command,
          cwd,
          taskModel: task.model,
          prompt: titlePrompt(messages.map(({ role, text }) => ({ role, text }))),
          signal: controller.signal,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    })().finally(() => {
      clearTimeout(timer);
      this.controllers.delete(controller);
      this.requests.delete(key);
    });
    this.requests.set(key, request);
    return request;
  }
  async dispose() {
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.requests.values(), ...this.automatic.values()]);
  }
}
