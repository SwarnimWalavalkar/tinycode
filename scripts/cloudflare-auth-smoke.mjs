import assert from "node:assert/strict";

// Local-only, no provider calls: start Wrangler with dummy GitHub OAuth settings.
const base = process.env.TINYCODE_SMOKE_URL ?? "http://localhost:8794";
assert(
  ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
  "This test only targets localhost",
);
const get = (path, init) => fetch(base + path, { redirect: "manual", ...init });
assert.equal((await get("/")).status, 200);
assert.deepEqual(await (await get("/api/auth")).json(), {
  mode: "github",
  user: null,
});
assert.equal((await get("/api/bootstrap")).status, 401);
assert.equal(
  (
    await get("/api/bootstrap", {
      headers: {
        authorization: "Bearer tinycode-local-smoke-token-not-a-secret",
        "x-tinycode-owner": "github-1",
      },
    })
  ).status,
  401,
);
const start = await get("/api/auth/github");
assert.equal(start.status, 303);
const target = new URL(start.headers.get("location"));
assert.equal(target.origin, "https://github.com");
assert.equal(target.pathname, "/login/oauth/authorize");
assert.equal(target.searchParams.get("code_challenge_method"), "S256");
assert.equal(target.searchParams.get("code_challenge").length, 43);
assert.equal(
  target.searchParams.get("redirect_uri"),
  base + "/api/auth/github/callback",
);
assert.equal(target.searchParams.get("scope"), "repo workflow offline_access");
assert.match(start.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
const state = target.searchParams.get("state");
// Never follow the GitHub redirect or submit a valid callback in this smoke test.
const missingCookie = await get(
  `/api/auth/github/callback?state=${state}&code=fake-code`,
);
assert.equal(missingCookie.status, 303);
assert.equal(missingCookie.headers.get("location"), "/?login_error=github");
const oauthCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
assert.ok(state);
assert.ok(oauthCookie);
const wrongState = (state[0] === "a" ? "b" : "a") + state.slice(1);
const mismatch = await get(`/api/auth/github/callback?state=${wrongState}&code=fake-code`, {
  headers: { cookie: oauthCookie },
});
assert.equal(mismatch.status, 303);
assert.equal(mismatch.headers.get("location"), "/?login_error=github");
const denied = await get("/api/logout", {
  method: "POST",
  headers: { origin: "https://evil.test" },
});
assert.equal(denied.status, 403);
console.log(
  "GitHub auth smoke passed: real Worker/Accounts RPC, PKCE redirect, cookie binding, legacy-token rejection, and CSRF protection. No GitHub requests made.",
);
