export interface ConnectionSettings {
  url: string;
  name: string;
}

const settingsKey = "tinycode-connection";
export const defaultServerUrl = location.origin;

export function normalizeServerUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a full server URL, such as http://localhost:4738.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTP or HTTPS URL without credentials, a query, or a fragment.");
  return url.href.replace(/\/+$/, "");
}

function readSettings(): ConnectionSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
    if (saved)
      return { url: normalizeServerUrl(saved.url), name: String(saved.name ?? "").slice(0, 80) };
  } catch {}
  return { url: defaultServerUrl, name: "" };
}

// A connection stays fixed for this page's lifetime. Switching reloads the app so
// requests, subscriptions, terminals and drafts cannot cross server boundaries.
export const connection = readSettings();
export const isLocalServer = (url = connection.url) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
export const connectionLabel = () =>
  connection.name || (isLocalServer() ? "Local workspace" : new URL(connection.url).host);
export const serverStorageKey = (key: string) =>
  connection.url === defaultServerUrl ? key : `${key}:${connection.url}`;
const tokenKey = (url: string) => `tinycode-token:${url}`;
export function readToken(url = connection.url) {
  try {
    return sessionStorage.getItem(tokenKey(url)) ?? "";
  } catch {
    return "";
  }
}

export function serverUrl(path: string, base = connection.url) {
  return `${base}${path}`;
}
export function serverFetch(
  path: string,
  init?: RequestInit,
  settings = connection,
  token = readToken(settings.url),
) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(serverUrl(path, settings.url), {
    ...init,
    headers,
    credentials: new URL(settings.url).origin === location.origin ? "same-origin" : "omit",
    redirect: "error",
  });
}

export function openSocket(settings = connection, token = readToken(settings.url)) {
  const url = new URL(serverUrl("/socket", settings.url));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(token)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  // Browser WebSockets cannot set Authorization. Keep the credential in the
  // handshake headers, never in URLs, and negotiate only the public protocol.
  return new WebSocket(url, token ? ["tinycode", `tinycode.auth.${encoded}`] : ["tinycode"]);
}

export async function checkConnection(
  settings: ConnectionSettings,
  token: string,
  signal: AbortSignal,
) {
  if (
    location.protocol === "https:" &&
    new URL(settings.url).protocol === "http:" &&
    !isLocalServer(settings.url)
  )
    throw new Error("Use an HTTPS server URL when Tinycode is opened over HTTPS.");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  let response: Response;
  try {
    response = await serverFetch(
      "/api/bootstrap",
      { signal: bounded, cache: "no-store" },
      settings,
      token,
    );
  } catch {
    if (signal.aborted) throw new Error("Connection cancelled.");
    throw new Error(
      `Could not reach this server. Check its URL and that it allows ${location.origin} in TINYCODE_ALLOWED_ORIGINS.`,
    );
  }
  if (response.status === 401) throw new Error("Enter the server's access token.");
  if (!response.ok)
    throw new Error(`Server returned ${response.status}. Check its URL and allowed origins.`);
  const data = await response.json().catch(() => null);
  if (
    data?.type !== "bootstrap" ||
    !Array.isArray(data.tasks) ||
    !Array.isArray(data.projects) ||
    !Array.isArray(data.providers)
  )
    throw new Error("This URL did not return a Tinycode server.");
  await new Promise<void>((resolve, reject) => {
    const socket = openSocket(settings, token);
    const timeout = setTimeout(
      () =>
        finish(
          new Error("Live connection timed out. Check that the server proxy supports WebSockets."),
        ),
      8000,
    );
    const abort = () => finish(new Error("Connection cancelled."));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      error ? reject(error) : resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.onopen = () => socket.send(JSON.stringify({ type: "ping", id: 1 }));
    socket.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.type === "pong" && packet.id === 1) finish();
      } catch {}
    };
    socket.onerror = socket.onclose = () =>
      finish(
        new Error(
          "Live connection failed. Check the access token, allowed origins, and WebSocket proxy.",
        ),
      );
    if (signal.aborted) abort();
  });
}

export function saveConnection(settings: ConnectionSettings, token: string) {
  if (token) sessionStorage.setItem(tokenKey(settings.url), token);
  else sessionStorage.removeItem(tokenKey(settings.url));
  localStorage.setItem(settingsKey, JSON.stringify(settings));
  // Keep the current task only when reconnecting to the same server.
  if (settings.url !== connection.url)
    history.replaceState(null, "", location.pathname + location.search);
  location.reload();
}
