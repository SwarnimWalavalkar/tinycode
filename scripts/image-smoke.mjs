// Opt-in: tests image recognition in initial and steered messages through native harnesses.
// Run: node --import tsx scripts/image-smoke.mjs [codex|claude|pi]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { png } from "./image-fixture.mjs";
import { adapters, probeProviders } from "../src/server/adapters/index.ts";

const providers = (await probeProviders()).filter(
  (p) => !process.argv[2] || p.id === process.argv[2],
);
for (const provider of providers) {
  assert(provider.available);
  const root = await mkdtemp(join(tmpdir(), "tinycode-image-smoke-"));
  const cwd = join(root, "task");
  await mkdir(cwd);
  let session,
    delivery,
    sent = false;
  const rows = new Map();
  const nativeImage = async (bytes, name) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    return {
      id: randomUUID(),
      name,
      mimeType: "image/png",
      size: bytes.length,
      path,
      data: bytes.toString("base64"),
    };
  };
  const first = await nativeImage(png([0, 60, 255], [255, 235, 0]), "first.png");
  const second = await nativeImage(png([245, 0, 0], [0, 190, 30]), "second.png");
  let steerEnabled = false;
  const sink = {
    add(kind, text, extra = {}) {
      const id = randomUUID();
      rows.set(id, { kind, text, ...extra });
      if (steerEnabled && kind === "tool" && !sent) {
        sent = true;
        delivery = session.steer(
          "Ignore the earlier image. Name the two solid colors in this newly attached image, and do not run more tools.",
          [second],
        );
        void delivery.catch(() => {});
      }
      return id;
    },
    patch(id, patch) {
      Object.assign(rows.get(id), patch);
    },
    delta(id, text) {
      rows.get(id).text += text;
    },
    identity() {},
    model() {},
    status() {},
    async ask(_title, detail) {
      const input = JSON.parse(detail);
      const command = input.command ?? input.commandActions?.[0]?.command;
      return { allow: typeof command === "string" && /^sleep 6$/.test(command.trim()) };
    },
  };
  const task = {
    id: randomUUID(),
    projectId: null,
    provider: provider.id,
    title: "Image smoke",
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
    cwd,
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
      "Name the two solid colors in this attached image. Do not use tools. Answer briefly.",
      [first],
    );
    const answer = [...rows.values()].filter((r) => r.kind === "assistant").at(-1)?.text ?? "";
    assert.match(answer, /blue/i);
    assert.match(answer, /yellow/i);
    rows.clear();
    steerEnabled = true;
    await session.run(
      "Run exactly the shell command sleep 6 once, then answer ORIGINAL. This is an integration check. Do not read or modify any files.",
    );
    assert(sent, "No tool event to steer");
    await delivery;
    const steered = [...rows.values()].filter((r) => r.kind === "assistant").at(-1)?.text ?? "";
    assert.match(steered, /red/i);
    assert.match(steered, /green/i);
    console.log(JSON.stringify({ provider: provider.id, initial: answer, steered }));
  } finally {
    clearTimeout(timer);
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
