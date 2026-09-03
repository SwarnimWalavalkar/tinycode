import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NativeImage } from "../images.js";

export const codexInput = (text: string, images: NativeImage[] = []) => [
  ...images.map((image) => ({ type: "localImage", path: image.path })),
  ...(text ? [{ type: "text", text }] : []),
];
export const piImages = (images: NativeImage[] = []) =>
  images.length
    ? {
        images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
      }
    : {};
export function claudeInput(
  text: string,
  images: NativeImage[] = [],
): SDKUserMessage["message"]["content"] {
  if (!images.length) return text;
  return [
    ...images.map(({ data, mimeType }) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: mimeType, data },
    })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}
// Native user-message events can echo the images back to the adapter.
export const IMAGE_FRAME_BYTES = 24 * 1024 * 1024;
