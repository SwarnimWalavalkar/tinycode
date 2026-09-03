// Opt-in: makes one small-model naming request through each installed harness.
// Run with: node --import tsx scripts/title-smoke.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters, probeProviders } from "../src/server/adapters/index.ts";
import { titlePrompt } from "../src/shared/titles.ts";

const providers = await probeProviders();
const results = await Promise.allSettled(
  providers
    .filter((p) => p.available)
    .map(async (provider) => {
      const cwd = await mkdtemp(join(tmpdir(), "tinycode-title-smoke-"));
      const start = performance.now();
      try {
        const result = await adapters[provider.id].generateTitle({
          cwd,
          command: provider.command,
          taskModel: provider.id === "pi" ? "openai-codex/gpt-5.6-luna" : null,
          signal: AbortSignal.timeout(45000),
          prompt: titlePrompt([
            {
              role: "user",
              text: "Add a right-click Rename menu to the task sidebar, with a small dialog and a suggested name based on the conversation.",
            },
          ]),
        });
        console.log(
          JSON.stringify({
            provider: provider.id,
            ...result,
            seconds: ((performance.now() - start) / 1000).toFixed(1),
          }),
        );
      } catch (error) {
        throw new Error(`${provider.id}: ${error.message}`);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }),
);
for (const result of results)
  if (result.status === "rejected") {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
