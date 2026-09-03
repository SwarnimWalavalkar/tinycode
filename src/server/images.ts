import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { ImageAttachment } from "../shared/contracts.js";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_MESSAGE_IMAGE_BYTES } from "../shared/images.js";
import type { Store } from "./db.js";

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export function imageType(bytes: Buffer): ImageAttachment["mimeType"] {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  throw new Error("Choose a PNG, JPEG, WebP, or GIF image");
}
export async function imageBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error("Each image must be 5 MB or smaller");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export class Images {
  private root: string;
  constructor(
    private store: Store,
    dataDir: string,
  ) {
    this.root = join(dataDir, "images");
  }
  private validId(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
      throw new Error("Invalid image ID");
  }
  get(id: string) {
    this.validId(id);
    const image = this.store.db
      .prepare("SELECT id, name, mime_type mimeType, size FROM images WHERE id = ?")
      .get(id) as ImageAttachment | undefined;
    if (!image) throw new Error("Image not found. Please attach it again.");
    return image;
  }
  path(image: ImageAttachment) {
    this.validId(image.id);
    return join(this.root, `${image.id}.${extensions[image.mimeType]}`);
  }
  async save(id: string, name: string, declaredType: string, bytes: Buffer) {
    this.validId(id);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
      throw new Error("Each image must be 5 MB or smaller");
    const mimeType = imageType(bytes);
    if (declaredType !== mimeType) throw new Error("The image format does not match its file type");
    const image: ImageAttachment = {
      id,
      name: name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 160) || `Image.${extensions[mimeType]}`,
      mimeType,
      size: bytes.length,
    };
    const existing = this.store.db.prepare("SELECT id FROM images WHERE id = ?").get(id);
    if (existing) {
      const saved = this.get(id);
      if (saved.mimeType !== mimeType || !(await readFile(this.path(saved))).equals(bytes))
        throw new Error("This image ID is already in use");
      return saved;
    }
    await mkdir(this.root, { recursive: true });
    try {
      await writeFile(this.path(image), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(this.path(image))).equals(bytes))
        throw new Error("This image ID is already in use");
    }
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO images (id,name,mime_type,size,created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, image.name, mimeType, image.size, new Date().toISOString());
    return this.get(id);
  }
  /** Called in the same transaction that accepts the queued message. */
  claim(taskId: string, ids: unknown): ImageAttachment[] {
    if (ids === undefined) return [];
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_IMAGES ||
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      throw new Error(`Attach up to ${MAX_IMAGES} images`);
    const images = ids.map((id) => this.get(id));
    if (images.reduce((sum, image) => sum + image.size, 0) > MAX_MESSAGE_IMAGE_BYTES)
      throw new Error("Images in one message must total 10 MB or less");
    for (const image of images) {
      const changed = this.store.db
        .prepare("UPDATE images SET task_id = ? WHERE id = ? AND (task_id IS NULL OR task_id = ?)")
        .run(taskId, image.id, taskId);
      if (!changed.changes) throw new Error("This image belongs to another task. Attach it again.");
    }
    return images;
  }
  async remove(id: string) {
    const image = this.get(id);
    const removed = this.store.db
      .prepare("DELETE FROM images WHERE id = ? AND task_id IS NULL")
      .run(id);
    if (removed.changes) await rm(this.path(image), { force: true });
  }
  async prune() {
    const stale = this.store.db
      .prepare("SELECT id FROM images WHERE task_id IS NULL AND created_at < ?")
      .all(new Date(Date.now() - 7 * 86400000).toISOString()) as { id: string }[];
    for (const { id } of stale) await this.remove(id);
  }
  async native(images: ImageAttachment[] = [], taskId: string, includeData = true) {
    return Promise.all(
      images.map(async (image) => {
        const owned = this.store.db
          .prepare("SELECT 1 FROM images WHERE id = ? AND task_id = ?")
          .get(image.id, taskId);
        if (!owned) throw new Error("Image is not attached to this task");
        const stored = this.get(image.id);
        return {
          ...stored,
          path: this.path(stored),
          data: includeData ? (await readFile(this.path(stored))).toString("base64") : "",
        };
      }),
    );
  }
}
export type NativeImage = ImageAttachment & { path: string; data: string };
