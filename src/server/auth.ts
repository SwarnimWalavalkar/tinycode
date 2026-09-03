import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function sameOrigin(
  req: IncomingMessage,
  configuredOrigin?: string,
  allowedOrigins: string[] = [],
) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
    if (allowedOrigins.includes(origin)) return true;
    return configuredOrigin
      ? new URL(origin).origin === new URL(configuredOrigin).origin
      : new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
export function websocketAuthenticated(req: IncomingMessage, token: string | undefined) {
  const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()) ?? [];
  const credential = protocols.find((p) => p.startsWith("tinycode.auth."));
  if (credential) {
    if (!token || !protocols.includes("tinycode")) return !token;
    const encoded = credential.slice("tinycode.auth.".length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
    return tokenMatches(Buffer.from(encoded, "base64url").toString("utf8"), token);
  }
  return authenticated(req, token);
}
export function tokenMatches(candidate: string, token: string) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function authenticated(req: IncomingMessage, token: string | undefined) {
  if (!token) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer /, "");
  const cookie = req.headers.cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("tinycode="))
    ?.slice(9);
  return tokenMatches(bearer ?? cookie ?? "", token);
}
