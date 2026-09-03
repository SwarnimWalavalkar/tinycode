// Verifies the remote-style authenticated upload boundary with separate client/server directories.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { png } from "./image-fixture.mjs";
const root = await mkdtemp(join(tmpdir(), "tinycode-image-http-"));
const base = "http://127.0.0.1:4742",
  token = "image-test-token-12345678901234567890";
const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TINYCODE_PORT: "4742",
    TINYCODE_HOST: "127.0.0.1",
    TINYCODE_DATA_DIR: root,
    TINYCODE_TOKEN: token,
    TINYCODE_ORIGIN: base,
    TINYCODE_ALLOWED_ORIGINS: "",
    TINYCODE_CODEX_BIN: join(root, "no-codex"),
    TINYCODE_CLAUDE_BIN: join(root, "no-claude"),
    TINYCODE_PI_BIN: join(root, "no-pi"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", (chunk) => (errors += chunk));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || "Startup timed out")), 15000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Tinycode ·")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(errors));
    });
  });
  const data = png([0, 60, 255], [255, 235, 0]),
    id = randomUUID();
  const path = `/api/images/${id}?name=Browser%20clipboard.png`;
  assert.equal(
    (
      await fetch(base + path, {
        method: "PUT",
        body: data,
        headers: { "Content-Type": "image/png" },
      })
    ).status,
    401,
  );
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ token }),
  });
  const headers = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    Origin: base,
    "Content-Type": "image/png",
  };
  assert.equal(
    (
      await fetch(base + path, {
        method: "PUT",
        body: data,
        headers: { ...headers, Origin: "https://other.example" },
      })
    ).status,
    403,
  );
  const upload = await fetch(base + path, { method: "PUT", body: data, headers });
  assert.equal(upload.status, 200);
  const image = await upload.json();
  assert.equal(image.name, "Browser clipboard.png");
  assert.equal(image.size, data.length);
  assert.equal((await fetch(base + path, { method: "PUT", body: data, headers })).status, 200);
  assert.equal((await fetch(base + `/api/images/${id}`)).status, 401);
  const view = await fetch(base + `/api/images/${id}`, { headers });
  assert.equal(view.headers.get("content-type"), "image/png");
  assert.equal(view.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await view.arrayBuffer()), data);
  assert.deepEqual(await readFile(join(root, "images", id + ".png")), data);
  assert.equal(
    (await fetch(base + `/api/images/${randomUUID()}`, { method: "PUT", body: "<svg/>", headers }))
      .status,
    400,
  );
  assert.equal(
    (await fetch(base + `/api/images/${id}`, { method: "DELETE", headers })).status,
    200,
  );
  assert.equal((await fetch(base + `/api/images/${id}`, { headers })).status, 400);
  console.log(
    "PASS: authenticated binary uploads, origin checks, idempotent retry, server-side bytes, authenticated previews, invalid images, draft removal",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
