export const devPort = 4737;

// Explicitly opt into development behind an authenticated reverse proxy.
// Production access control is configured separately.
export function developmentOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.TINYCODE_DEV_ORIGIN?.trim();
  if (env.NODE_ENV === "production" || !value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TINYCODE_DEV_ORIGIN must be an HTTP(S) origin without credentials or paths");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname.includes("*") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("TINYCODE_DEV_ORIGIN must be an HTTP(S) origin without credentials or paths");
  return url.origin;
}
