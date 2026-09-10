import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { accountStore } from "./accounts.js";
import { ownerId } from "./ownership.js";

export class Sandbox extends CloudflareSandbox<Env> {
  override interceptHttps = true;
  private boundOwner?: string;
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
