import type { Env } from "./env.js";

export function allowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return (
    origin === new URL(request.url).origin ||
    (env.TINYCODE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes(origin)
  );
}

export async function matches(
  candidate: string,
  expected: string,
): Promise<boolean> {
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(candidate), digest(expected)]);
  const av = new Uint8Array(a),
    bv = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < av.length; i++) difference |= av[i] ^ bv[i];
  return difference === 0;
}

export async function authorized(
  request: Request,
  token: string,
): Promise<boolean> {
  const bearer = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (bearer !== undefined) return matches(bearer, token);
  const protocol = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((p) => p.trim());
  const credential = protocol?.find((p) => p.startsWith("tinycode.auth."));
  if (credential) {
    if (!protocol?.includes("tinycode")) return false;
    const encoded = credential.slice("tinycode.auth.".length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
    try {
      return matches(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
        token,
      );
    } catch {
      return false;
    }
  }
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("__Host-tinycode="))
    ?.slice("__Host-tinycode=".length);
  return cookie ? matches(cookie, await sessionToken(token)) : false;
}

/** Domain-separated cookie: the deployment secret itself is never set as a cookie. */
export async function sessionToken(token: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode("tinycode-browser-session-v1"),
    ),
  );
  return Array.from(signature)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
