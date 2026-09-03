// Explicit opt-in: exercises installed harnesses with short real model turns.
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const base = process.env.TINYCODE_SMOKE_URL ?? "http://127.0.0.1:4738";
const api = async (path, body) => {
  const r = await fetch(base + "/api" + path, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json" },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
};
const project = await api("/projects", {
  path: new URL("../.tinycode/smoke-project", import.meta.url).pathname,
});
const results = [];
for (const provider of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["codex", "claude", "pi"]) {
  const task = await api("/tasks", { projectId: project.id, provider });
  const record = { provider, id: task.id, turns: [] };
  results.push(record);
  for (const text of [
    "This is a Tinycode integration test. Do not use tools. Remember the word tangerine and reply with exactly READY.",
    "What was the word I asked you to remember? Reply with only that word; do not use tools.",
  ]) {
    await api(`/tasks/${task.id}/send`, { text, requestId: randomUUID() });
    let state;
    const deadline = Date.now() + 90000;
    do {
      await new Promise((r) => setTimeout(r, 1000));
      state = (await api("/bootstrap")).tasks.find((t) => t.id === task.id);
    } while (["running", "waiting"].includes(state.status) && Date.now() < deadline);
    const timeline = await api(`/tasks/${task.id}/timeline`);
    record.turns.push({
      status: state.status,
      nativeId: state.nativeSessionId,
      output: timeline.items
        .filter((i) => ["assistant", "error"].includes(i.kind))
        .map((i) => ({ kind: i.kind, text: i.text }))
        .slice(-3),
    });
    console.log(JSON.stringify({ provider, turn: record.turns.length, ...record.turns.at(-1) }));
    if (state.status !== "complete") {
      if (["running", "waiting"].includes(state.status))
        await api(`/tasks/${task.id}/interrupt`, {});
      break;
    }
  }
}
await writeFile(
  new URL("../.tinycode/smoke-results.json", import.meta.url),
  JSON.stringify(results, null, 2),
);
