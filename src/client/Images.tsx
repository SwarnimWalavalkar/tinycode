import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import type { ImageAttachment } from "../shared/contracts";
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_IMAGE_BYTES,
  imageUrl,
} from "../shared/images";
import { api } from "./state";
import { serverFetch } from "./connection";

function ServerImage({
  image,
  link = false,
}: {
  image: { id: string; name: string };
  link?: boolean;
}) {
  const element = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let started = false;
    setSrc(undefined);
    setFailed(false);
    async function load() {
      if (started) return;
      started = true;
      try {
        const response = await serverFetch(imageUrl(image.id), { signal: controller.signal });
        if (!response.ok) throw new Error("Image unavailable");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      controller.abort();
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.id, attempt]);
  const preview = (
    <img
      ref={element}
      src={src}
      alt={failed ? `Image unavailable: ${image.name}` : image.name}
      decoding="async"
    />
  );
  return link ? (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open image: ${image.name}`}
      title={failed ? "Image unavailable. Click to retry." : image.name}
      onClick={(event) => {
        if (!src) {
          event.preventDefault();
          if (failed) setAttempt((value) => value + 1);
        }
      }}
    >
      {preview}
    </a>
  ) : (
    preview
  );
}

interface DraftImage {
  id: string;
  file: File | null;
  name: string;
  size: number;
  url: string;
  status: "uploading" | "ready" | "error";
  error?: string;
}
export function useDraftImages() {
  const [images, setImages] = useState<DraftImage[]>([]);
  const [error, setError] = useState("");
  const current = useRef(images);
  const uploads = useRef(new Map<string, AbortController>());
  function update(next: DraftImage[]) {
    current.current = next;
    setImages(next);
  }
  async function upload(image: DraftImage) {
    if (!image.file) return;
    const controller = new AbortController();
    uploads.current.set(image.id, controller);
    update(
      current.current.map((item) =>
        item.id === image.id ? { ...item, status: "uploading", error: undefined } : item,
      ),
    );
    try {
      await api<ImageAttachment>(
        `/images/${image.id}?name=${encodeURIComponent(image.file.name)}`,
        {
          method: "PUT",
          headers: { "Content-Type": image.file.type },
          body: image.file,
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted)
        update(
          current.current.map((item) =>
            item.id === image.id ? { ...item, status: "ready" } : item,
          ),
        );
    } catch (e) {
      if (!controller.signal.aborted)
        update(
          current.current.map((item) =>
            item.id === image.id
              ? { ...item, status: "error", error: e instanceof Error ? e.message : String(e) }
              : item,
          ),
        );
    } finally {
      uploads.current.delete(image.id);
    }
  }
  function add(files: File[]) {
    setError("");
    const accepted: DraftImage[] = [];
    let bytes = current.current.reduce((sum, image) => sum + image.size, 0);
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setError("Choose PNG, JPEG, WebP, or GIF images.");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError("Each image must be 5 MB or smaller.");
        continue;
      }
      if (
        current.current.length + accepted.length >= MAX_IMAGES ||
        bytes + file.size > MAX_MESSAGE_IMAGE_BYTES
      ) {
        setError(`Attach up to ${MAX_IMAGES} images, totaling 10 MB or less.`);
        break;
      }
      bytes += file.size;
      accepted.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        size: file.size,
        url: URL.createObjectURL(file),
        status: "uploading",
      });
    }
    update([...current.current, ...accepted]);
    for (const image of accepted) void upload(image);
  }
  function clear(ids: string[]) {
    for (const image of current.current) if (ids.includes(image.id)) URL.revokeObjectURL(image.url);
    update(current.current.filter((image) => !ids.includes(image.id)));
    setError("");
  }
  function remove(id: string) {
    uploads.current.get(id)?.abort();
    clear([id]);
    void api(`/images/${id}`, { method: "DELETE" }).catch(() => {});
  }
  function replace(attachments: ImageAttachment[]) {
    for (const controller of uploads.current.values()) controller.abort();
    for (const image of current.current) URL.revokeObjectURL(image.url);
    update(
      attachments.map((image) => ({
        id: image.id,
        name: image.name,
        size: image.size,
        file: null,
        url: imageUrl(image.id),
        status: "ready",
      })),
    );
    setError("");
  }
  useEffect(
    () => () => {
      for (const controller of uploads.current.values()) controller.abort();
      for (const image of current.current) URL.revokeObjectURL(image.url);
    },
    [],
  );
  return {
    images,
    error,
    add,
    clear,
    remove,
    replace,
    retry: upload,
    ready: images.every((image) => image.status === "ready"),
  };
}

export function ImageShelf({
  draft,
  disabled,
}: {
  draft: ReturnType<typeof useDraftImages>;
  disabled: boolean;
}) {
  return (
    <div
      className={`image-shelf ${draft.images.length ? "open" : ""}`}
      aria-label="Image attachments"
      aria-hidden={!draft.images.length}
    >
      <div className="image-shelf-content">
        <div className="image-shelf-tray">
          {draft.images.map((image, index) => (
            <div
              className="draft-image"
              key={image.id}
              style={{ "--image-index": index } as CSSProperties}
            >
              {image.file ? (
                <img src={image.url} alt={image.name || "Pasted image"} />
              ) : (
                <ServerImage image={image} />
              )}
              <button
                className="image-remove"
                aria-label={`Remove image: ${image.name}`}
                title="Remove image"
                disabled={disabled}
                onClick={() => draft.remove(image.id)}
              >
                <X size={13} />
              </button>
              {image.status === "uploading" && (
                <span
                  className="image-upload-state"
                  role="status"
                  aria-label={`Uploading ${image.name}`}
                >
                  <LoaderCircle size={16} className="spin" />
                </span>
              )}
              {image.status === "error" && (
                <button
                  className="image-upload-state image-retry"
                  aria-label={`Retry upload: ${image.name}`}
                  title={image.error}
                  onClick={() => void draft.retry(image)}
                >
                  <RotateCcw size={16} />
                  <span>Retry</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MessageImages({
  images,
  compact = false,
}: {
  images?: ImageAttachment[];
  compact?: boolean;
}) {
  if (!images?.length) return null;
  return (
    <div className={`message-images ${compact ? "compact" : ""}`}>
      {(compact ? images.slice(0, 1) : images).map((image) => (
        <ServerImage key={image.id} image={image} link />
      ))}
      {compact && images.length > 1 && <span className="image-count">+{images.length - 1}</span>}
    </div>
  );
}
