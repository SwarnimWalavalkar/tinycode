import { CLOUDFLARE_AGENT_PROTOCOL } from "../../../src/shared/cloudflare-agent.js";
import {
  allowedOrigin,
  authorized,
  matches,
  sessionToken,
  SESSION_MAX_AGE_MS,
} from "./auth.js";
import { body, failure, HttpError, json, text } from "./http.js";
import { modelCatalog } from "./models.js";
import { providers } from "./directory.js";
import type { Env } from "./env.js";

import {
  ACCOUNT_SESSION_MS,
  SESSION_COOKIE,
  OAUTH_COOKIE,
  accountStore,
  cookie,
  githubAuthEnabled,
  assertGithubConfig,
} from "./accounts.js";
import { directoryName, personalWorkspace, LEGACY_OWNER } from "./ownership.js";
export { Accounts } from "./accounts.js";
export { Sandbox } from "./sandbox.js";
export { ContainerProxy } from "@cloudflare/sandbox";

const clearCookie = (name: string) =>
  `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
}
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
      const github = githubAuthEnabled(env);
      if (github) assertGithubConfig(env);
      if (!github && !env.TINYCODE_AGENT_TOKEN?.trim())
        throw new HttpError(503, "Configure a non-empty TINYCODE_AGENT_TOKEN");
      if (
        github &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        request.headers.get("origin") !== url.origin
      )
        throw new HttpError(
          403,
          "Use the Tinycode website to perform this action",
        );
      if (url.pathname === "/api/auth" && request.method === "GET") {
        const session = github
          ? await accountStore(env).session(cookie(request, SESSION_COOKIE))
          : null;
        response = json({
          mode: github ? "github" : "token",
          user: session
            ? await accountStore(env).profile(session.user.id)
            : null,
        });
      } else if (
        github &&
        url.pathname === "/api/auth/github" &&
        request.method === "GET"
      ) {
        const start = await accountStore(env).begin(
          `${url.origin}/api/auth/github/callback`,
        );
        response = redirect(start.url, [
          `${OAUTH_COOKIE}=${start.state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
        ]);
      } else if (
        github &&
        url.pathname === "/api/auth/github/callback" &&
        request.method === "GET"
      ) {
        try {
          const state = url.searchParams.get("state") ?? "";
          if (
            !/^[A-Za-z0-9_-]{43}$/.test(state) ||
            state !== cookie(request, OAUTH_COOKIE) ||
            url.searchParams.has("error")
          )
            throw new HttpError(400, "GitHub sign-in was cancelled or expired");
          const code = url.searchParams.get("code") ?? "";
          if (!code || code.length > 1024)
            throw new HttpError(400, "Missing GitHub authorization code");
          const session = await accountStore(env).complete(
            state,
            code,
            `${url.origin}/api/auth/github/callback`,
          );
          response = redirect("/", [
            clearCookie(OAUTH_COOKIE),
            `${SESSION_COOKIE}=${session.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ACCOUNT_SESSION_MS / 1000}`,
          ]);
        } catch {
          response = redirect("/?login_error=github", [
            clearCookie(OAUTH_COOKIE),
          ]);
        }
      } else if (request.method === "OPTIONS")
        response = new Response(null, { status: 204 });
      else if (
        !github &&
        url.pathname === "/api/login" &&
        request.method === "POST"
      ) {
        const input = await body(request);
        if (
          !(await matches(text(input.token, 4096), env.TINYCODE_AGENT_TOKEN!))
        )
          throw new HttpError(401, "Invalid access token");
        response = json({ ok: true });
        response.headers.set(
          "set-cookie",
          `__Host-tinycode=${await sessionToken(env.TINYCODE_AGENT_TOKEN!)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}`,
        );
      } else {
        const session = github
          ? await accountStore(env).session(cookie(request, SESSION_COOKIE))
          : null;
        if (
          github
            ? !session
            : !(await authorized(request, env.TINYCODE_AGENT_TOKEN!))
        )
          throw new HttpError(
            401,
            github
              ? "Sign in with GitHub to continue"
              : "Enter this server's access token",
          );
        const owner = session?.user.id ?? LEGACY_OWNER;
        const directory = env.DIRECTORY.get(
          env.DIRECTORY.idFromName(directoryName(personalWorkspace(owner))),
        );
        const ownedRequest = (target: URL | string, source = request) => {
          const headers = new Headers(source.headers);
          headers.set("x-tinycode-owner", owner);
          headers.delete("x-tinycode-session-expires");
          if (session)
            headers.set(
              "x-tinycode-session-expires",
              String(session.expiresAt),
            );
          return new Request(new Request(target, source), { headers });
        };
        if (
          github &&
          url.pathname === "/api/logout" &&
          request.method === "POST"
        ) {
          await accountStore(env).logout(cookie(request, SESSION_COOKIE));
          await directory.fetch(ownedRequest("https://internal/close-sockets"));
          response = json({ ok: true });
          response.headers.set("set-cookie", clearCookie(SESSION_COOKIE));
        } else if (
          github &&
          url.pathname === "/api/auth/github" &&
          request.method === "DELETE"
        ) {
          await accountStore(env).disconnect(owner);
          response = json({ ok: true });
        } else if (url.pathname === "/api/health")
          response = json({
            ok: true,
            ready: providers(env)[0].available,
            version: "0.2.0",
            protocol: CLOUDFLARE_AGENT_PROTOCOL,
            authority: "cloud",
          });
        else if (url.pathname === "/api/providers")
          response = json(providers(env));
        else if (url.pathname === "/api/models")
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
            const target = new URL(
              `https://internal/task/${task[1]}/${task[2] ?? "state"}`,
            );
            target.search = url.search;
            response = await directory.fetch(ownedRequest(target));
          } else if (
            ["/api/bootstrap", "/api/tasks", "/socket"].includes(
              url.pathname,
            ) ||
            /^\/api\/images\/[A-Za-z0-9_-]+$/.test(url.pathname)
          ) {
            url.pathname = url.pathname.replace(/^\/api/, "");
            response = await directory.fetch(ownedRequest(url));
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
