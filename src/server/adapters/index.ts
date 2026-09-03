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
  claude: { name: "Claude Code", create: createClaude, generateTitle: claudeTitle },
  pi: { name: "Pi", create: createPi, generateTitle: piTitle },
};
export async function probeProviders(): Promise<ProviderInfo[]> {
  return Promise.all(
    (Object.keys(adapters) as ProviderId[]).map(async (id) => {
      let command = process.env[`TINYCODE_${id.toUpperCase()}_BIN`] ?? id;
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
        version = (await exec(command, ["--version"], { timeout: 6000, maxBuffer: 16384 })).stdout
          .trim()
          .split("\n")
          .at(-1);
      } catch {}
      return {
        id,
        name: adapters[id].name,
        command,
        available: !!version,
        version,
        capabilities: {
          resume: true,
          steer: true,
          interrupt: true,
          approvals: id === "pi" ? "none" : "native",
          subagents: id === "pi" ? "events" : "native",
        },
      };
    }),
  );
}
