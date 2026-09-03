import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ImageAttachment, ProviderInfo } from "../shared/contracts.js";
import { MAX_IMAGE_BYTES } from "../shared/images.js";
import { Store } from "./db.js";
import { Images, type NativeImage } from "./images.js";
import { Runtime } from "./runtime.js";
import { adapters } from "./adapters/index.js";
import { createTask } from "./tasks.js";
import { claudeInput, codexInput, piImages } from "./adapters/images.js";

vi.mock("./adapters/thinking.js", () => ({
  thinkingOptions: async () => ({ levels: [], defaultLevel: null }),
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFukAAAAASUVORK5CYII=",
  "base64",
);
const fixtures: { root: string; store: Store; runtime: Runtime; taskId: string }[] = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function stop(runtime: Runtime, store: Store, taskId: string) {
  runtime.dispose();
  if (!store.db.open) return;
  // Image reads can outlive a single event-loop tick. Wait for the runtime's
  // persisted turn completion before closing the database it still uses.
  await vi.waitFor(() =>
    expect(store.timeline(taskId).turns.every((turn) => turn.status !== "running")).toBe(true),
  );
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await stop(f.runtime, f.store, f.taskId);
    if (f.store.db.open) f.store.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tinycode-images-test-"));
  const store = new Store(join(root, "state.db"));
  const images = new Images(store, root);
  const task = await createTask(store, root, {
    projectId: null,
    provider: "pi",
    model: null,
    thinkingLevel: null,
    branch: null,
  });
  const provider: ProviderInfo = {
    id: "pi",
    name: "Pi",
    command: "fake",
    available: true,
    capabilities: {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: "none",
      subagents: "events",
    },
  };
  const runtime = new Runtime(store, [provider], root, () => {});
  const runs: { text: string; images: NativeImage[]; finish: () => void }[] = [];
  const steers: { text: string; images: NativeImage[] }[] = [];
  vi.spyOn(adapters.pi, "create").mockResolvedValue({
    run: (text, images = []) => new Promise<void>((finish) => runs.push({ text, images, finish })),
    steer: async (text, images = []) => {
      steers.push({ text, images });
    },
    interrupt: async () => {
      runs.at(-1)?.finish();
    },
    dispose: () => {
      runs.forEach((run) => run.finish());
    },
  });
  fixtures.push({ root, store, runtime, taskId: task.id });
  const upload = () => images.save(randomUUID(), "Photo.png", "image/png", png);
  return { root, store, images, task, runtime, runs, steers, upload, provider };
}
it("stores bytes on the server, verifies types and bounds, and retries the same upload safely", async () => {
  const { images, root, upload } = await fixture();
  const image = await upload();
  expect(images.path(image)).toContain(join(root, "images"));
  expect(await readFile(images.path(image))).toEqual(png);
  expect(await images.save(image.id, "Retry.png", "image/png", png)).toEqual(image);
  await expect(
    images.save(randomUUID(), "fake.png", "image/png", Buffer.from('<svg onload="bad"/>')),
  ).rejects.toThrow("Choose a PNG");
  await expect(images.save(randomUUID(), "wrong.jpg", "image/jpeg", png)).rejects.toThrow(
    "does not match",
  );
  await expect(images.save("../../private", "test.png", "image/png", png)).rejects.toThrow(
    "Invalid image",
  );
  await expect(
    images.save(randomUUID(), "large.png", "image/png", Buffer.alloc(MAX_IMAGE_BYTES + 1)),
  ).rejects.toThrow("5 MB");
  const changed = Buffer.from(png);
  changed[changed.length - 1] ^= 1;
  await expect(images.save(image.id, "Changed.png", "image/png", changed)).rejects.toThrow(
    "already in use",
  );
});
it("persists images through new turns, FIFO queueing, and steering without putting image bytes in events", async () => {
  const { images, task, runtime, runs, steers, store, upload } = await fixture();
  const first = await upload(),
    second = await upload(),
    third = await upload();
  await runtime.send(task, "Describe this", "first", "queue", [first.id]);
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  expect(runs[0].images[0].data).toBe(png.toString("base64"));
  await runtime.send(task, "Next image", "second", "queue", [second.id]);
  await runtime.send(task, "Duplicate retry", "second", "queue", [second.id]);
  expect(store.queue(task.id)[0].images).toEqual([second]);
  await runtime.send(task, "Use this instead", "third", "steer", [third.id]);
  await vi.waitFor(() => expect(steers).toHaveLength(1));
  expect(steers[0].images[0].data).toBe(png.toString("base64"));
  await tick();
  expect(store.timeline(task.id).items.map((m) => m.images?.[0].id)).toEqual([first.id, third.id]);
  expect(JSON.stringify(store.timeline(task.id))).not.toContain(png.toString("base64"));
  await images.remove(first.id);
  expect(await readFile(images.path(first))).toEqual(png);
  runs[0].finish();
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].images[0].id).toBe(second.id);
});
it("allows image-only messages and rolls back invalid attachment claims and request receipts", async () => {
  const { images, task, runtime, runs, store, upload } = await fixture();
  const image = await upload();
  await expect(runtime.send(task, "", "retry", "queue", [image.id, randomUUID()])).rejects.toThrow(
    "Image not found",
  );
  expect(store.db.prepare("SELECT task_id FROM images WHERE id=?").get(image.id)).toEqual({
    task_id: null,
  });
  await runtime.send(task, "", "retry", "queue", [image.id]);
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  expect(runs[0].text).toBe("");
  expect(runs[0].images).toHaveLength(1);
  expect(store.task(task.id)?.title).toBe("Image attachment");
  expect(() => store.db.transaction(() => images.claim("another-task", [image.id]))()).toThrow(
    "another task",
  );
  await expect(runtime.send(task, "", "empty")).rejects.toThrow("attach an image");
});
it("keeps queued and transcript images after restart and only removes unattached uploads", async () => {
  const { root, store, images, runtime, task, upload } = await fixture();
  const first = await upload(),
    second = await upload(),
    unused = await upload();
  await runtime.send(task, "First", "1", "queue", [first.id]);
  await runtime.send(task, "Second", "2", "queue", [second.id]);
  await images.remove(unused.id);
  expect(() => images.get(unused.id)).toThrow("not found");
  await stop(runtime, store, task.id);
  store.db.close();
  const reopened = new Store(join(root, "state.db"));
  try {
    const restartedImages = new Images(reopened, root);
    expect(reopened.queue(task.id)[0].images).toEqual([second]);
    expect(reopened.timeline(task.id).items[0].images).toEqual([first]);
    expect((await restartedImages.native([second], task.id))[0].data).toBe(png.toString("base64"));
  } finally {
    reopened.db.close();
  }
});
it("uses native image blocks for all three harnesses, including image-only input", () => {
  const image: NativeImage = {
    id: randomUUID(),
    name: "Photo.png",
    mimeType: "image/png",
    size: png.length,
    path: "/server/images/photo.png",
    data: png.toString("base64"),
  };
  expect(codexInput("Look", [image])).toEqual([
    { type: "localImage", path: image.path },
    { type: "text", text: "Look" },
  ]);
  expect(piImages([image])).toEqual({
    images: [{ type: "image", data: image.data, mimeType: "image/png" }],
  });
  expect(claudeInput("Look", [image])).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
    { type: "text", text: "Look" },
  ]);
  expect(claudeInput("", [image])).toHaveLength(1);
  expect(codexInput("", [image])).toHaveLength(1);
  expect(claudeInput("plain")).toBe("plain");
});

it("keeps attached images when queued text is edited, including an image-only edit", async () => {
  const { task, runtime, runs, store, upload } = await fixture();
  await runtime.send(task, "First", "1");
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  const image = await upload();
  await runtime.send(task, "Describe this", "2", "queue", [image.id]);
  runtime.editQueued(task.id, "2", "", "Describe this");
  expect(store.queue(task.id)[0]).toMatchObject({ text: "", images: [image] });
  runs[0].finish();
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].text).toBe("");
  expect(runs[1].images[0].id).toBe(image.id);
  expect(store.timeline(task.id).items.at(-1)).toMatchObject({ text: "", images: [image] });
});

it("saves replacement attachments atomically and rejects stale image edits", async () => {
  const { task, runtime, runs, store, upload } = await fixture();
  await runtime.send(task, "First", "1");
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  const first = await upload(),
    replacement = await upload(),
    stale = await upload();
  await runtime.send(task, "Original", "2", "queue", [first.id]);
  runtime.editQueued(task.id, "2", "Edited", "Original", [replacement.id], [first.id]);
  // An HTTP retry after a lost response is safe even though the expected version is now old.
  runtime.editQueued(task.id, "2", "Edited", "Original", [replacement.id], [first.id]);
  expect(() => runtime.editQueued(task.id, "2", "Stale", "Edited", [stale.id], [first.id])).toThrow(
    "edited elsewhere",
  );
  expect(store.db.prepare("SELECT task_id FROM images WHERE id = ?").get(stale.id)).toEqual({
    task_id: null,
  });
  expect(() => runtime.editQueued(task.id, "2", "", "Edited", [], [replacement.id])).toThrow(
    "Write a message",
  );
  expect(store.queue(task.id)[0]).toMatchObject({ text: "Edited", images: [replacement] });
  runtime.editQueued(task.id, "2", "No image", "Edited", [], [replacement.id]);
  expect(store.queue(task.id)[0].images).toBeUndefined();
  runtime.editQueued(task.id, "2", "", "No image", [replacement.id], []);
  runs[0].finish();
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].images.map((image) => image.id)).toEqual([replacement.id]);
  expect(store.timeline(task.id).items.at(-1)).toMatchObject({ text: "", images: [replacement] });
});
