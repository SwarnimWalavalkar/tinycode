export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

export function text(value: unknown, max = 100_000): string {
  if (typeof value !== "string" || value.length > max)
    throw new HttpError(400, "Invalid text field");
  return value;
}

export function identifier(value: unknown): string {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new HttpError(400, "Invalid identifier");
  return id;
}

export async function bytes(
  request: Request,
  max: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > max)
    throw new HttpError(413, "Request is too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413, "Request is too large");
      }
      chunks.push(chunk.value);
    }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function body(
  request: Request,
  max = 1024 * 1024,
): Promise<Record<string, any>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Expected application/json");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder().decode(await bytes(request, max)) || "{}",
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Expected an object");
  return value as Record<string, any>;
}

export const failure = (error: unknown) =>
  json(
    { error: error instanceof Error ? error.message : "Request failed" },
    error instanceof HttpError ? error.status : 500,
  );

export async function checked<T>(response: Response): Promise<T> {
  const value = (await response.json()) as any;
  if (!response.ok)
    throw new HttpError(response.status, value.error ?? "Cloud request failed");
  return value as T;
}

export const internal = (path: string, value: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
