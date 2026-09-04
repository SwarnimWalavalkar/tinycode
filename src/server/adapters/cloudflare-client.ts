import type {
  CloudflareHealth,
  CloudflareModelCatalog,
  CloudflareTitleRequest,
  CloudflareTitleResponse,
} from "../../shared/cloudflare-agent.js";

const TOKEN_ENV = "TINYCODE_CLOUDFLARE_AGENT_TOKEN";

function validateAgentUrl(url: URL): URL {
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("TINYCODE_CLOUDFLARE_AGENT_URL must be an HTTPS origin");
  return url;
}

export function cloudflareAgentUrl(): string | undefined {
  const value = process.env.TINYCODE_CLOUDFLARE_AGENT_URL?.trim();
  if (!value) return undefined;
  const url = validateAgentUrl(new URL(value));
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  return url.href.replace(/\/$/, "");
}

function token(): string {
  const value = process.env[TOKEN_ENV]?.trim();
  if (!value) throw new Error(`${TOKEN_ENV} is not configured`);
  return value;
}

export function cloudflareEndpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function cloudflareFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const endpoint = validateAgentUrl(new URL(cloudflareEndpoint(base, path)));
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token()}`);
  headers.set("accept", "application/json, application/x-ndjson");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(endpoint.href, { ...init, headers });
}

export async function cloudflareResponseError(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => "");
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return new Error(parsed.error);
    } catch {}
    return new Error(detail);
  }
  return new Error(`Cloudflare agent returned ${response.status}`);
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await cloudflareResponseError(response);
  return response.json() as Promise<T>;
}

export async function cloudflareHealth(base: string): Promise<CloudflareHealth> {
  return json(
    await cloudflareFetch(base, "/v1/health", { signal: AbortSignal.timeout(6_000) }),
  );
}

export async function cloudflareModels(base: string): Promise<CloudflareModelCatalog> {
  return json(
    await cloudflareFetch(base, "/v1/models", { signal: AbortSignal.timeout(15_000) }),
  );
}

export async function cloudflareTitle(
  base: string,
  request: CloudflareTitleRequest,
  signal: AbortSignal,
): Promise<CloudflareTitleResponse> {
  return json(
    await cloudflareFetch(base, "/v1/title", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    }),
  );
}
