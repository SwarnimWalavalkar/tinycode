import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderInfo } from "../../shared/contracts.js";
import { JsonLines } from "./jsonl.js";

const exec = promisify(execFile);

/** Ask native auth/catalog APIs; never submit a prompt or return credentials. */
export async function harnessAuthenticated(provider: ProviderInfo, cwd: string): Promise<boolean> {
  if (provider.id === "claude") {
    const env = { ...process.env };
    delete env.TINYCODE_TOKEN;
    try {
      const { stdout } = await exec(provider.command, ["auth", "status", "--json"], {
        cwd,
        env,
        timeout: 10000,
        maxBuffer: 65536,
      });
      return JSON.parse(stdout).loggedIn === true;
    } catch (error) {
      // Claude exits nonzero when signed out, but still supplies structured status.
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout && JSON.parse(stdout).loggedIn === false) return false;
      throw new Error("Could not check Claude Code authentication");
    }
  }
  const rpc = new JsonLines(
    provider.command,
    provider.id === "codex"
      ? ["app-server", "--listen", "stdio://"]
      : ["--mode", "rpc", "--no-session"],
    cwd,
  );
  rpc.onMessage = (message) => {
    if (message.method && message.id !== undefined)
      rpc.send({
        id: message.id,
        error: { code: -32601, message: "Authentication check only" },
      });
    if (message.type === "extension_ui_request")
      rpc.send({
        type: "extension_ui_response",
        id: message.id,
        cancelled: true,
      });
  };
  try {
    if (provider.id === "pi") {
      // Pi's native catalog includes only models with configured credentials,
      // including extension providers and endpoints that don't require a key.
      const catalog = await rpc.request({ type: "get_available_models" }, 15000);
      return Array.isArray(catalog?.models) && catalog.models.length > 0;
    }
    await rpc.request(
      {
        method: "initialize",
        params: {
          clientInfo: { name: "tinycode", title: "Tinycode", version: "0.1.0" },
          capabilities: {},
        },
      },
      10000,
    );
    rpc.send({ method: "initialized" });
    const account = await rpc.request(
      { method: "account/read", params: { refreshToken: true } },
      10000,
    );
    return account?.account != null || account?.requiresOpenaiAuth === false;
  } finally {
    rpc.dispose();
  }
}
