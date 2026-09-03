import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, statSync } from "node:fs";

// node-pty 1.1.0 ships its Unix prebuilt helper without executable mode on
// some package-manager installs. Restore the packaged executable's mode.
if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const directory of [
    `prebuilds/${process.platform}-${process.arch}`,
    "build/Release",
    "build/Debug",
  ]) {
    const path = join(root, directory, "spawn-helper");
    if (existsSync(path)) chmodSync(path, statSync(path).mode | 0o111);
  }
}
