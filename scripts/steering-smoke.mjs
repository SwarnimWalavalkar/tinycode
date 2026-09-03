// Opt-in: short real harness turns, in disposable directories, using installed credentials.
// Run with: node --import tsx scripts/steering-smoke.mjs [codex|claude|pi]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { adapters, probeProviders } from "../src/server/adapters/index.ts";

const providers = await probeProviders();
for (const provider of providers.filter((p) => !process.argv[2] || p.id === process.argv[2])) {
  assert(provider.available, `${provider.name} is not installed`);
  const root = await mkdtemp(join(tmpdir(), "tinycode-steering-smoke-"));
  let session;
  let delivery;
  let sent = false;
  const messages = new Map();
  const sink = {
    add(kind, text, extra = {}) {
      const id = randomUUID();
      messages.set(id, { kind, text, ...extra });
      if (kind === "tool" && !sent) {
        sent = true;
        delivery = session.steer(
          "Change the final response to exactly STEERED. Do not run any more tools.",
        );
        void delivery.catch(() => {});
      }
      return id;
    },
    patch(id, patch) {
      Object.assign(messages.get(id), patch);
    },
    delta(id, text) {
      messages.get(id).text += text;
    },
    identity() {},
    model() {},
    status() {},
    async ask(_title, detail) {
      const input = JSON.parse(detail);
      const command = input.command ?? input.commandActions?.[0]?.command;
      return { allow: typeof command === "string" && /^sleep [46]$/.test(command.trim()) };
    },
  };
  const task = {
    id: randomUUID(),
    projectId: null,
    provider: provider.id,
    title: "Steering smoke",
    model:
      provider.id === "claude"
        ? "haiku"
        : provider.id === "pi"
          ? "openai-codex/gpt-5.6-luna"
          : "gpt-5.6-luna",
    thinkingLevel: null,
    nativeSessionId: null,
    status: "idle",
    attentionId: null,
    cwd: root,
    worktreePath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const timer = setTimeout(() => session?.dispose(), 90000);
  try {
    session = await adapters[provider.id].create({
      task,
      sink,
      command: provider.command,
      dataDir: root,
    });
    await session.run(
      "This is an integration test. Run the shell command sleep 6 exactly once, then reply only ORIGINAL. Do not read or modify any files.",
    );
    assert(sent, "Harness did not start the requested test command");
    await delivery;
    const answer = [...messages.values()].filter((m) => m.kind === "assistant").at(-1)?.text;
    assert.match(
      answer ?? "",
      /STEERED/,
      `Native steering was not reflected in the answer: ${answer}`,
    );
    console.log(JSON.stringify({ provider: provider.id, nativeSteering: "passed", answer }));
  } finally {
    clearTimeout(timer);
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
