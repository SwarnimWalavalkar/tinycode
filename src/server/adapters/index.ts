import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ProviderId, ProviderInfo } from "../../shared/contracts.js";
import type { AdapterContext, AdapterSession } from "./types.js";
import { createCodex } from "./codex.js";
import { createPi } from "./pi.js";
import { createClaude } from "./claude.js";
import { codexTitle, claudeTitle, piTitle, type TitleGenerator } from "./titles.js";
import { harnessAuthenticated } from "./readiness.js";

const exec = promisify(execFile);
export const adapters: Record<
  ProviderId,
  {
    name: string;
    create: (ctx: AdapterContext) => Promise<AdapterSession>;
    generateTitle: TitleGenerator;
  }
> = {
  codex: { name: "Codex", create: createCodex, generateTitle: codexTitle },
  claude: {
    name: "Claude Code",
    create: createClaude,
    generateTitle: claudeTitle,
  },
  pi: { name: "Pi", create: createPi, generateTitle: piTitle },
};
export function pendingProviders(): ProviderInfo[] {
  return (Object.keys(adapters) as ProviderId[]).map((id) => ({
    id,
    name: adapters[id].name,
    command: process.env[`TINYCODE_${id.toUpperCase()}_BIN`] ?? id,
    available: false,
    readiness: "checking",
    capabilities: {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: id === "pi" ? "none" : "native",
      subagents: id === "pi" ? "events" : "native",
    },
  }));
}
export async function probeProviders(
  cwd: string,
  onChecked?: (provider: ProviderInfo) => void,
): Promise<ProviderInfo[]> {
  return Promise.all(
    pendingProviders().map(async (provider) => {
      let command = provider.command;
      if (!command.includes("/"))
        for (const part of (process.env.PATH ?? "").split(delimiter)) {
          const path = join(part, command);
          try {
            await access(path, constants.X_OK);
            command = path;
            break;
          } catch {}
        }
      let version: string | undefined;
      try {
        version = (
          await exec(command, ["--version"], {
            timeout: 6000,
            maxBuffer: 16384,
          })
        ).stdout
          .trim()
          .split("\n")
          .at(-1);
      } catch {}
      provider = { ...provider, command, version, readiness: "missing" };
      if (!version) {
        onChecked?.(provider);
        return provider;
      }
      try {
        provider.available = await harnessAuthenticated(provider, cwd);
        provider.readiness = provider.available ? "ready" : "unauthenticated";
      } catch {
        provider.readiness = "error";
      }
      onChecked?.(provider);
      return provider;
    }),
  );
}
