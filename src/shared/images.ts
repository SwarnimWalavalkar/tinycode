export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 6;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const imageUrl = (id: string) => `/api/images/${encodeURIComponent(id)}`;
