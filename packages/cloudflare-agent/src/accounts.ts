import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { HttpError } from "./http.js";
import { ownerId } from "./ownership.js";

export const ACCOUNT_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "__Host-tinycode-session";
export const OAUTH_COOKIE = "__Host-tinycode-oauth";
export interface Account {
  id: string;
  login: string;
  name: string;
  email: string;
}
export interface AccountSession {
  user: Account;
  expiresAt: number;
}
interface Credential {
  access: string;
  refresh?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
export const randomToken = () =>
  encode(crypto.getRandomValues(new Uint8Array(32)));
export const hashToken = async (value: string) =>
  encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
export const githubAuthEnabled = (env: Env) =>
  !!(
    env.GITHUB_OAUTH_CLIENT_ID ||
    env.GITHUB_OAUTH_CLIENT_SECRET ||
    env.TINYCODE_AUTH_SECRET
  );
export function assertGithubConfig(env: Env) {
  if (
    !env.GITHUB_OAUTH_CLIENT_ID ||
    !env.GITHUB_OAUTH_CLIENT_SECRET ||
    (env.TINYCODE_AUTH_SECRET?.length ?? 0) < 32
  )
    throw new HttpError(
      503,
      "Configure GitHub OAuth and TINYCODE_AUTH_SECRET (at least 32 characters)",
    );
}
export function cookie(request: Request, name: string) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  );
}
export const accountStore = (env: Env) =>
  env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "tinycode",
  "x-github-api-version": "2026-03-10",
});

/** Private control-plane API. Never routed directly from public HTTP or sandbox URLs. */
export class Accounts extends DurableObject<Env> {
  private refreshing = new Map<string, Promise<Credential>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, profile TEXT NOT NULL, credential TEXT);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }
  private async seal(value: Credential, owner: string) {
    const key = await this.key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
  }
  private async key() {
    assertGithubConfig(this.env);
    return crypto.subtle.importKey(
      "raw",
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(this.env.TINYCODE_AUTH_SECRET!),
      ),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  private async unseal(value: string, owner: string): Promise<Credential> {
    const [iv, data] = value.split(".");
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: decode(iv),
            additionalData: new TextEncoder().encode(owner),
          },
          await this.key(),
          decode(data),
        ),
      ),
    );
  }
  async begin(redirectUri: string) {
    assertGithubConfig(this.env);
    const state = randomToken(),
      verifier = randomToken();
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth WHERE expires < ?",
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM sessions WHERE expires < ?",
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth VALUES (?,?,?,?)",
      state,
      verifier,
      redirectUri,
      Date.now() + 600_000,
    );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.env.GITHUB_OAUTH_CLIENT_ID!,
      redirect_uri: redirectUri,
      scope: "repo workflow offline_access",
      state,
      code_challenge: await hashToken(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { state, url: url.href };
  }
  private async exchange(fields: Record<string, string>): Promise<Credential> {
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.env.GITHUB_OAUTH_CLIENT_ID!,
          client_secret: this.env.GITHUB_OAUTH_CLIENT_SECRET!,
          ...fields,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new HttpError(
        502,
        "GitHub authorization is unavailable; try again",
      );
    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.access_token !== "string" || data.token_type !== "bearer")
      throw new HttpError(401, "Reconnect GitHub to continue");
    const scopes =
      typeof data.scope === "string" ? data.scope.split(/[ ,]+/) : [];
    if (!scopes.includes("repo") || !scopes.includes("workflow"))
      throw new HttpError(
        403,
        "Allow repository and workflow access to connect GitHub",
      );
    const expiry = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? Date.now() + value * 1000
        : undefined;
    return {
      access: data.access_token,
      refresh:
        typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresAt: expiry(data.expires_in),
      refreshExpiresAt: expiry(data.refresh_token_expires_in),
    };
  }
  async complete(state: string, code: string, redirectUri: string) {
    const row = this.ctx.storage.sql
      .exec<{ verifier: string; redirect: string; expires: number }>(
        "DELETE FROM oauth WHERE state=? RETURNING verifier,redirect,expires",
        state,
      )
      .toArray()[0];
    if (!row || row.expires <= Date.now() || row.redirect !== redirectUri)
      throw new HttpError(400, "Sign-in expired; try again");
    const credential = await this.exchange({
      code,
      code_verifier: row.verifier,
      redirect_uri: redirectUri,
    });
    const response = await fetch("https://api.github.com/user", {
      headers: githubHeaders(credential.access),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new HttpError(502, "Could not verify your GitHub account");
    const value = (await response.json()) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.id) ||
      Number(value.id) <= 0 ||
      typeof value.login !== "string" ||
      !/^[A-Za-z0-9-]+$/.test(value.login)
    )
      throw new HttpError(502, "Invalid GitHub account response");
    const user: Account = {
      id: `github-${value.id}`,
      login: value.login,
      name: typeof value.name === "string" ? value.name : value.login,
      email: `${value.id}+${value.login}@users.noreply.github.com`,
    };
    // Serialize with refresh/disconnect so an older refresh cannot overwrite a new grant.
    await this.refreshing.get(user.id)?.catch(() => {});
    const sealed = await this.seal(credential, user.id);
    this.ctx.storage.sql.exec(
      "INSERT INTO users VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,credential=excluded.credential",
      user.id,
      JSON.stringify(user),
      sealed,
    );
    const token = randomToken(),
      expiresAt = Date.now() + ACCOUNT_SESSION_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions VALUES (?,?,?)",
      await hashToken(token),
      user.id,
      expiresAt,
    );
    return { token, user, expiresAt };
  }
  async session(token: string): Promise<AccountSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.ctx.storage.sql
      .exec<{ profile: string; expires: number }>(
        "SELECT profile,expires FROM sessions JOIN users ON users.id=sessions.owner WHERE hash=? AND expires>?",
        await hashToken(token),
        Date.now(),
      )
      .toArray()[0];
    return row
      ? { user: JSON.parse(row.profile), expiresAt: row.expires }
      : null;
  }
  async logout(token: string) {
    this.ctx.storage.sql.exec(
      "DELETE FROM sessions WHERE hash=?",
      await hashToken(token),
    );
  }
  async profile(owner: string): Promise<Account & { connected: boolean }> {
    const row = this.ctx.storage.sql
      .exec<{ profile: string; credential: string | null }>(
        "SELECT profile,credential FROM users WHERE id=?",
        ownerId(owner),
      )
      .toArray()[0];
    if (!row) throw new HttpError(404, "Account not found");
    return { ...JSON.parse(row.profile), connected: !!row.credential };
  }
  async disconnect(owner: string) {
    ownerId(owner);
    await this.refreshing.get(owner)?.catch(() => {});
    this.ctx.storage.sql.exec(
      "UPDATE users SET credential=NULL WHERE id=?",
      owner,
    );
  }
  private async credential(owner: string): Promise<Credential> {
    if (this.refreshing.has(owner)) return this.refreshing.get(owner)!;
    const operation = this.loadCredential(owner);
    this.refreshing.set(owner, operation);
    try {
      return await operation;
    } finally {
      this.refreshing.delete(owner);
    }
  }
  private async loadCredential(owner: string): Promise<Credential> {
    const row = this.ctx.storage.sql
      .exec<{ credential: string | null }>(
        "SELECT credential FROM users WHERE id=?",
        ownerId(owner),
      )
      .toArray()[0];
    if (!row?.credential)
      throw new HttpError(401, "Reconnect GitHub in Tinycode to continue");
    const credential = await this.unseal(row.credential, owner);
    if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000)
      return credential;
    if (
      !credential.refresh ||
      (credential.refreshExpiresAt && credential.refreshExpiresAt <= Date.now())
    ) {
      this.ctx.storage.sql.exec(
        "UPDATE users SET credential=NULL WHERE id=? AND credential=?",
        owner,
        row.credential,
      );
      throw new HttpError(401, "Reconnect GitHub in Tinycode to continue");
    }
    let refreshed: Credential;
    try {
      refreshed = await this.exchange({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401)
        this.ctx.storage.sql.exec(
          "UPDATE users SET credential=NULL WHERE id=? AND credential=?",
          owner,
          row.credential,
        );
      throw error;
    }
    const saved = this.ctx.storage.sql
      .exec(
        "UPDATE users SET credential=? WHERE id=? AND credential=? RETURNING id",
        await this.seal(refreshed, owner),
        owner,
        row.credential,
      )
      .toArray();
    return saved.length ? refreshed : this.loadCredential(owner);
  }
  async github(owner: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    // API token-management endpoints must never expose or mint credentials in the VM.
    const api =
      url.origin === "https://api.github.com" &&
      /^\/(?:repos\/|user(?:\/repos)?$|user\/orgs$|orgs\/[^/]+\/repos$|search\/|graphql$)/.test(
        url.pathname,
      );
    const git =
      url.origin === "https://github.com" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(
        url.pathname,
      );
    if ((!api && !git) || url.username || url.password)
      return new Response("GitHub endpoint is not supported", { status: 403 });
    let credential: Credential;
    try {
      credential = await this.credential(owner);
    } catch (error) {
      return new Response(
        error instanceof HttpError
          ? error.message
          : "GitHub connection unavailable",
        { status: error instanceof HttpError ? error.status : 503 },
      );
    }
    const headers = new Headers();
    for (const name of [
      "accept",
      "content-type",
      "git-protocol",
      "if-none-match",
      "range",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set(
      "authorization",
      git
        ? `Basic ${btoa(`x-access-token:${credential.access}`)}`
        : `Bearer ${credential.access}`,
    );
    headers.set("user-agent", "tinycode");
    if (api) headers.set("x-github-api-version", "2026-03-10");
    const response = await fetch(
      new Request(request, { headers, redirect: "manual" }),
    );
    if (response.status === 401) {
      // Do not invalidate a newer grant that arrived while the request was in flight.
      const row = this.ctx.storage.sql
        .exec<{ credential: string | null }>(
          "SELECT credential FROM users WHERE id=?",
          owner,
        )
        .toArray()[0];
      if (
        row?.credential &&
        (await this.unseal(row.credential, owner)).access === credential.access
      )
        this.ctx.storage.sql.exec(
          "UPDATE users SET credential=NULL WHERE id=? AND credential=?",
          owner,
          row.credential,
        );
    }
    const outgoing = new Headers(response.headers);
    for (const name of ["set-cookie", "authorization", "proxy-authorization"])
      outgoing.delete(name);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outgoing,
    });
  }
}
