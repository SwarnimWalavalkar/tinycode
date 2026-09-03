// Explicit opt-in: verifies selected models against short real native turns.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = process.env.TINYCODE_SMOKE_URL ?? "http://127.0.0.1:4738";
async function api(path, body) {
  const response = await fetch(base + "/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
const boot = await api("/bootstrap");
const project = boot.projects.find((p) => p.path.endsWith("/.tinycode/smoke-project"));
assert(project, "Create the disposable smoke fixture first");
for (const provider of ["codex", "claude", "pi"]) {
  const catalog = await api("/models?" + new URLSearchParams({ provider, projectId: project.id }));
  assert(catalog.models.length > 0);
  const choice =
    catalog.models.find((m) =>
      provider === "claude"
        ? m.id === "haiku"
        : m.id.includes("gpt-5.6-luna") && (provider !== "pi" || m.id.startsWith("openai-codex/")),
    ) ?? catalog.models[0];
  let task = await api("/tasks", { projectId: project.id, provider, model: choice.id });
  const firstId = task.id;
  await api(`/tasks/${task.id}/send`, {
    text: "Model selector check. Do not use tools. Remember apricot and reply only READY.",
    requestId: randomUUID(),
  });
  const blocked = await fetch(base + `/api/tasks/${task.id}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: choice.id }),
  });
  assert.equal(blocked.status, 400, "model changes are blocked while a turn is active");
  async function wait() {
    const deadline = Date.now() + 90000;
    do {
      await new Promise((r) => setTimeout(r, 500));
      task = (await api("/bootstrap")).tasks.find((t) => t.id === firstId);
    } while (["running", "waiting"].includes(task.status) && Date.now() < deadline);
    assert.equal(task.status, "complete", JSON.stringify(await api(`/tasks/${task.id}/timeline`)));
    assert(task.nativeSessionId);
    assert(task.resolvedModel, "harness must report the model it actually used");
  }
  await wait();
  assert.equal(task.model, choice.id);
  assert.equal(task.resolvedModel, choice.resolvedId ?? choice.id);
  const nativeId = task.nativeSessionId;
  if (provider === "codex") {
    const next =
      catalog.models.find((m) => m.id === "gpt-5.6-terra") ??
      catalog.models.find((m) => m.id !== choice.id);
    assert(next);
    task = await api(`/tasks/${task.id}/model`, { model: next.id });
    assert.equal(task.nativeSessionId, nativeId);
    assert.equal(task.resolvedModel, null);
    await api(`/tasks/${task.id}/send`, {
      text: "What word did I ask you to remember? Reply only that word. Do not use tools.",
      requestId: randomUUID(),
    });
    await wait();
    assert.equal(task.nativeSessionId, nativeId);
    assert.equal(task.resolvedModel, next.id);
    const timeline = await api(`/tasks/${task.id}/timeline`);
    assert.match(timeline.items.filter((i) => i.kind === "assistant").at(-1).text, /apricot/i);
  }
  console.log(
    JSON.stringify({
      provider,
      taskId: task.id,
      selected: task.model,
      reported: task.resolvedModel,
      status: task.status,
      resumed: provider === "codex",
    }),
  );
}
