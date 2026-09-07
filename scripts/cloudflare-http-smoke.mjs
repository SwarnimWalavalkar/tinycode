import assert from "node:assert/strict";
import { WebSocket } from "ws";

// Run against `wrangler dev --local`; no provider credentials or production resources.
const base = process.env.TINYCODE_SMOKE_URL ?? "http://localhost:8794";
assert(
  ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
  "This test only targets localhost",
);
const token = "tinycode-local-smoke-token-not-a-secret";
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const api = (path, input, method = "POST") =>
  fetch(base + path, {
    method: input === undefined ? "GET" : method,
    headers,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
const ok = async (response) => {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error("Timed out waiting for durable state");
}
assert.equal((await fetch(base + "/")).status, 200);
assert.equal((await fetch(base + "/api/bootstrap")).status, 401);
assert.equal(
  (
    await fetch(base + "/api/bootstrap", {
      headers: { ...headers, origin: "https://evil.test" },
    })
  ).status,
  403,
);
const health = await ok(await api("/v1/health"));
assert.equal(health.authority, "cloud");
assert.equal(
  health.ready,
  false,
  "Unset OPENAI_API_KEY before running this credential-free smoke test",
);
const login = await api("/api/login", { token });
assert.equal(login.status, 200);
assert.match(
  login.headers.get("set-cookie"),
  /HttpOnly; Secure; SameSite=Strict/,
);
const task = await ok(
  await api("/api/tasks", {
    provider: "cloudflare",
    requestId: "smoke-durable-http-v2",
  }),
);
const path = `/api/tasks/${task.id}`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);
const imagePath = "/api/images/smoke-durable-image-v2";
assert.equal(
  (
    await fetch(base + imagePath, {
      method: "PUT",
      headers: { ...headers, "content-type": "image/png" },
      body: png,
    })
  ).status,
  200,
);
const message = {
  requestId: "smoke-durable-request-v2",
  text: "Durable acceptance smoke",
  images: ["smoke-durable-image-v2"],
};
assert.deepEqual(await ok(await api(path + "/send", message)), {
  ok: true,
  runId: message.requestId,
});
// No socket has been connected. The alarm must dispatch and persist the missing-key failure.
await eventually(
  async () => (await ok(await api(path))).task.status === "failed",
);
const snapshot = await ok(await api(path + "/snapshot"));
assert.equal(snapshot.items.filter((item) => item.kind === "user").length, 1);
assert(
  snapshot.items.some(
    (item) => item.kind === "error" && item.text.includes("OPENAI_API_KEY"),
  ),
);
assert.equal(snapshot.queue.length, 0);
assert.equal((await api(path + "/send", message)).status, 200);
assert.equal(
  (await api(path + "/send", { ...message, text: "changed" })).status,
  409,
);
await api(imagePath, {}, "DELETE");
assert.equal(
  (await api(imagePath)).status,
  200,
  "Accepted attachments cannot be deleted as drafts",
);
const second = await ok(
  await api("/api/tasks", {
    provider: "cloudflare",
    requestId: "smoke-durable-other-v2",
  }),
);
assert.equal(
  (await api(`/api/tasks/${second.id}/send`, message)).status,
  409,
  "Attachments are task scoped",
);
const events = await ok(await api(path + "/events?after=0"));
assert(events.events.length > 0);

async function connect() {
  const socket = new WebSocket(
    base.replace(/^http/, "ws") + "/socket",
    ["tinycode"],
    { headers: { authorization: `Bearer ${token}` } },
  );
  const packets = [];
  socket.on("message", (data) => packets.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "subscribe", taskId: task.id }));
  await eventually(async () =>
    packets.some((packet) => packet.type === "timeline"),
  );
  return { socket, packets };
}
const first = await connect();
assert.equal(
  first.packets.find((packet) => packet.type === "timeline").items.length,
  snapshot.items.length,
);
first.socket.close();
await ok(await api(path + "/title", { title: "Changed while disconnected" }));
const reconnected = await connect();
await eventually(async () =>
  reconnected.packets.some(
    (packet) =>
      packet.type === "bootstrap" &&
      packet.tasks.some((task) => task.title === "Changed while disconnected"),
  ),
);
assert.equal(
  reconnected.packets.find((packet) => packet.type === "timeline").items.length,
  snapshot.items.length,
);
reconnected.socket.close();
console.log(
  "Cloudflare HTTP smoke passed: assets, auth, DO alarm dispatch, SQL transcript/receipts, R2 ownership, WebSocket reconnect. Run again after restarting Wrangler with the same persist directory to verify recovery.",
);
