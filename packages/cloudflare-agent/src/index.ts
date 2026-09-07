import { CLOUDFLARE_AGENT_PROTOCOL } from "../../../src/shared/cloudflare-agent.js";
import { allowedOrigin, authorized, matches, sessionToken } from "./auth.js";
import { body, failure, HttpError, json, text } from "./http.js";
import { modelCatalog } from "./models.js";
import { providers } from "./directory.js";
import type { Env } from "./env.js";

export { Sandbox } from "@cloudflare/sandbox";
export { DurablePiAgent } from "./agent.js";
export { TaskDirectory } from "./directory.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const api =
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/v1/") ||
      url.pathname === "/socket";
    if (!api) return env.ASSETS.fetch(request);
    let response: Response;
    try {
      if (!allowedOrigin(request, env))
        throw new HttpError(403, "Origin is not allowed");
      if (!env.TINYCODE_AGENT_TOKEN || env.TINYCODE_AGENT_TOKEN.length < 24)
        throw new HttpError(
          503,
          "Configure TINYCODE_AGENT_TOKEN with at least 24 characters",
        );
      if (request.method === "OPTIONS")
        response = new Response(null, { status: 204 });
      else if (url.pathname === "/api/login" && request.method === "POST") {
        const input = await body(request);
        if (!(await matches(text(input.token, 4096), env.TINYCODE_AGENT_TOKEN)))
          throw new HttpError(401, "Invalid access token");
        response = json({ ok: true });
        response.headers.set(
          "set-cookie",
          `__Host-tinycode=${await sessionToken(env.TINYCODE_AGENT_TOKEN)}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        );
      } else {
        if (!(await authorized(request, env.TINYCODE_AGENT_TOKEN)))
          throw new HttpError(401, "Enter this server's access token");
        if (url.pathname === "/v1/health")
          response = json({
            ok: true,
            ready: providers(env)[0].available,
            version: "0.2.0",
            protocol: CLOUDFLARE_AGENT_PROTOCOL,
            authority: "cloud",
          });
        else if (url.pathname === "/api/providers")
          response = json(providers(env));
        else if (["/v1/models", "/api/models"].includes(url.pathname))
          response = json(modelCatalog(env));
        else if (url.pathname === "/api/thinking") {
          const model = modelCatalog(env).models.find(
            (m) => m.id === url.searchParams.get("model"),
          );
          response = json({
            levels: model?.thinkingLevels ?? [],
            defaultLevel: model?.defaultThinkingLevel ?? null,
          });
        } else {
          const task = url.pathname.match(
            /^\/api\/tasks\/([A-Za-z0-9_-]+)(?:\/(.*))?$/,
          );
          if (task) {
            const target = new URL(`https://internal/${task[2] ?? "state"}`);
            target.search = url.search;
            response = await env.AGENTS.get(
              env.AGENTS.idFromName(task[1]),
            ).fetch(new Request(target, request));
          } else if (
            ["/api/bootstrap", "/api/tasks", "/socket"].includes(
              url.pathname,
            ) ||
            /^\/api\/images\/[A-Za-z0-9_-]+$/.test(url.pathname)
          ) {
            url.pathname = url.pathname.replace(/^\/api/, "");
            response = await env.DIRECTORY.get(
              env.DIRECTORY.idFromName("default"),
            ).fetch(new Request(url, request));
          } else if (
            url.pathname.startsWith("/v1/agents/") ||
            url.pathname === "/v1/title"
          ) {
            throw new HttpError(
              410,
              "The request-bound agent protocol was replaced. Use /api/tasks and durable send/events endpoints.",
            );
          } else throw new HttpError(404, "Not found");
        }
      }
    } catch (error) {
      response =
        error instanceof HttpError && error.status === 401
          ? json({ error: error.message, authRequired: true }, 401)
          : failure(error);
    }
    if (response.status === 101) return response;
    response = new Response(response.body, response);
    response.headers.set("vary", "Origin, Authorization, Cookie");
    const origin = request.headers.get("origin");
    if (origin && allowedOrigin(request, env)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("access-control-allow-credentials", "true");
      response.headers.set(
        "access-control-allow-methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      response.headers.set(
        "access-control-allow-headers",
        "Authorization, Content-Type",
      );
    }
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  },
} satisfies ExportedHandler<Env>;
