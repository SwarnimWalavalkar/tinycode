import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { accountStore } from "./accounts.js";
import { ownerId } from "./ownership.js";

export class Sandbox extends CloudflareSandbox<Env> {
  override interceptHttps = true;
  private boundOwner?: string;
  async ensureTerminalSession(env: Record<string, string>) {
    try {
      await this.createSession({ id: "tinycode-terminal", cwd: "/workspace", env });
    } catch (error) {
      // Handle the SDK error here: custom error fields do not survive DO RPC.
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "SESSION_ALREADY_EXISTS") throw error;
    }
    const session = await this.getSession("tinycode-terminal");
    const result = await session.exec("python3 /usr/local/lib/tinycode-terminal.py ensure", { env, timeout: 10_000 });
    if (!result.success) throw new Error("Terminal service failed to start");
  }
  private workspaceStartup?: Promise<void>;
  async readWorkspace(action: "tree" | "file", path: string) {
    const started = Date.now();
    const response = await this.fetchWorkspace(action, path);
    console.info({ event: "workspace.read", action, durationMs: Date.now() - started, status: response.status });
    return response;
  }
  private async fetchWorkspace(action: "tree" | "file", path: string) {
    const request = () => new Request(`http://localhost/${action}?path=${encodeURIComponent(path)}`);
    try {
      const response = await this.containerFetch(request(), 3002);
      if (response.status < 500) return response;
    } catch { /* The service is started lazily after container startup or sleep. */ }
    if (!this.workspaceStartup) {
      this.workspaceStartup = (async () => {
        const result = await this.exec("python3 /usr/local/lib/workspace_server.py ensure", { timeout: 10_000 });
        if (!result.success) throw new Error("Workspace service failed to start");
      })().finally(() => { this.workspaceStartup = undefined; });
    }
    await this.workspaceStartup;
    return this.containerFetch(request(), 3002);
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/tinycode-terminal")
      return this.containerFetch(new Request("http://localhost/terminal", request), 3001);
    return super.fetch(request);
  }
  /** Ownership only arrives through trusted RPC, never from guest headers. */
  async bindGithub(owner: string) {
    ownerId(owner);
    if (this.boundOwner === owner) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.boundOwner === owner) return;
      const retained = await this.ctx.storage.get<string>("github-owner");
      if (retained && retained !== owner)
        throw new Error("Sandbox belongs to another account");
      await this.setOutboundByHost("github.com", "github", { owner });
      await this.setOutboundByHost("api.github.com", "github", { owner });
      if (!retained) await this.ctx.storage.put("github-owner", owner);
      this.boundOwner = owner;
    });
  }
}

export async function githubOutbound(
  request: Request,
  env: Env,
  ctx: { params?: unknown },
) {
  const owner = (ctx.params as { owner?: string } | undefined)?.owner;
  if (!owner)
    return new Response("GitHub account is not connected", { status: 403 });
  const url = new URL(request.url);
  // Ordinary public pages still work. Only Git transport and API requests use credentials.
  if (
    url.origin === "https://github.com" &&
    !/\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname)
  ) {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
  return accountStore(env).github(ownerId(owner), request);
}
Sandbox.outboundHandlers = { github: githubOutbound };
