import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingProviders, probeProviders } from "./adapters/index.js";
import { harnessAuthenticated } from "./adapters/readiness.js";
import { clearModelCatalogs, modelCatalog } from "./adapters/models.js";
import type { ProviderId } from "../shared/contracts.js";

const directories: string[] = [];
async function fixture(id: ProviderId, response: object) {
  const cwd = await mkdtemp(join(tmpdir(), "tinycode-readiness-"));
  directories.push(cwd);
  const command = join(cwd, "harness.cjs");
  await writeFile(join(cwd, "response.json"), JSON.stringify(response));
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const response = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'response.json'), 'utf8'));
if (process.argv.includes('--version')) { console.log('test 1.0'); process.exit(0); }
if (process.env.TINYCODE_TOKEN) { console.error('Token leaked to child'); process.exit(2); }
if (process.argv.includes('auth')) { console.log(JSON.stringify(response())); process.exit(response().loggedIn ? 0 : 1); }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const action = message.method || message.type;
  fs.appendFileSync(path.join(__dirname, 'calls'), action + '\\n');
  if (!message.id) return;
  const value = action === 'initialize' ? {} : action === 'get_state' ? {model: {provider: 'signed-out', id: 'default'}} : response();
  console.log(JSON.stringify(message.method ? {id: message.id, result: value} : {id: message.id, type: 'response', success: true, data: value}));
});
`,
  );
  await chmod(command, 0o755);
  return {
    cwd,
    provider: {
      ...pendingProviders().find((p) => p.id === id)!,
      command,
      available: true,
    },
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  clearModelCatalogs();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
describe("native harness readiness", () => {
  it.each([
    [{ account: null, requiresOpenaiAuth: true }, false],
    [{ account: { type: "chatgpt" }, requiresOpenaiAuth: true }, true],
    [{ account: { type: "apiKey" }, requiresOpenaiAuth: true }, true],
    [{ account: null, requiresOpenaiAuth: false }, true],
    [{}, false],
  ])("checks Codex account state without starting a turn: %j", async (response, expected) => {
    const { cwd, provider } = await fixture("codex", response);
    vi.stubEnv("TINYCODE_TOKEN", "never-pass-this-to-a-harness");
    expect(await harnessAuthenticated(provider, cwd)).toBe(expected);
    expect(await readFile(join(cwd, "calls"), "utf8")).toBe(
      "initialize\ninitialized\naccount/read\n",
    );
  });
  it.each([true, false])(
    "uses Claude's structured login status including nonzero signed-out exit: %s",
    async (loggedIn) => {
      const { cwd, provider } = await fixture("claude", { loggedIn });
      vi.stubEnv("TINYCODE_TOKEN", "never-pass-this-to-a-harness");
      expect(await harnessAuthenticated(provider, cwd)).toBe(loggedIn);
    },
  );
  it.each([{ models: [] }, { models: [{ provider: "custom", id: "model" }] }])(
    "uses Pi's credential-aware catalog: %j",
    async ({ models }) => {
      const { cwd, provider } = await fixture("pi", { models });
      expect(await harnessAuthenticated(provider, cwd)).toBe(models.length > 0);
      expect(await readFile(join(cwd, "calls"), "utf8")).toBe("get_available_models\n");
    },
  );
  it("does not confuse installation with readiness and detects a later login", async () => {
    const { cwd, provider } = await fixture("claude", { loggedIn: false });
    vi.stubEnv("TINYCODE_CODEX_BIN", join(cwd, "missing-codex"));
    vi.stubEnv("TINYCODE_PI_BIN", join(cwd, "missing-pi"));
    vi.stubEnv("TINYCODE_CLAUDE_BIN", provider.command);
    let providers = await probeProviders(cwd);
    expect(providers.map((p) => p.available)).toEqual([false, false, false, false]);
    expect(providers.find((p) => p.id === "claude")?.readiness).toBe("unauthenticated");
    expect(providers.find((p) => p.id === "pi")?.readiness).toBe("missing");
    await writeFile(join(cwd, "response.json"), JSON.stringify({ loggedIn: true }));
    providers = await probeProviders(cwd);
    expect(providers.find((p) => p.id === "claude")?.available).toBe(true);
  });
  it("uses an authenticated Pi model when the saved default is unavailable", async () => {
    const { cwd, provider } = await fixture("pi", {
      models: [{ provider: "custom", id: "ready", name: "Ready" }],
    });
    expect((await modelCatalog(provider, cwd)).defaultModel).toBe("custom/ready");
  });
});
