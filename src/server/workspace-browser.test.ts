import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { browseDirectories, diff, git, gitStatus, tree } from "./workspace.js";
const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tinycode-browse-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("browses server folders, supports spaces and directory links, and hides files and dotfolders by default", async () => {
  const root = await fixture();
  await mkdir(join(root, "a folder"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file.txt"), "hello");
  await symlink(join(root, "a folder"), join(root, "linked"));
  await symlink(join(root, "absent"), join(root, "broken"));
  const listing = await browseDirectories(root);
  expect(listing.path).toBe(root);
  expect(listing.parent).toBe(dirname(root));
  expect(listing.directories.map((d) => d.name)).toEqual(["a folder", "linked"]);
  expect(listing.truncated).toBe(false);
  expect((await browseDirectories(root, true)).directories.map((d) => d.name)).toContain(".hidden");
  expect((await browseDirectories(join(root, "linked"))).path).toBe(join(root, "a folder"));
  await expect(browseDirectories(join(root, "file.txt"))).rejects.toThrow();
  await expect(browseDirectories(join(root, "missing"))).rejects.toThrow();
});
it("lists one workspace level at a time and retains workspace containment", async () => {
  const root = await fixture();
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "a.ts"), "export {};");
  expect((await tree(root)).map((e) => e.path)).toEqual(["src"]);
  expect((await tree(root, "src/")).map((e) => e.path)).toEqual(["src/a.ts"]);
  await expect(tree(root, "../")).rejects.toThrow("outside");
});
it("returns every untracked file and supplies parseable Diffs data for new, changed, and deleted files", async () => {
  const root = await fixture();
  await git(root, ["init"]);
  await writeFile(join(root, "changed.ts"), 'export const hello = "before";\n');
  await writeFile(join(root, "deleted.txt"), "delete me\n");
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "fixture",
  ]);
  await writeFile(join(root, "changed.ts"), 'export const hello = "after";\n');
  await rm(join(root, "deleted.txt"));
  await mkdir(join(root, "new"));
  await writeFile(join(root, "new", "[one].ts"), "const one = 1;\n");
  await writeFile(join(root, "new", "empty.txt"), "");
  expect((await gitStatus(root)).files.map((f) => f.path)).toEqual([
    "changed.ts",
    "deleted.txt",
    "new/[one].ts",
    "new/empty.txt",
  ]);
  const changed = parsePatchFiles((await diff(root, "changed.ts")).content)[0].files[0];
  expect(changed.additionLines.join("\n")).toContain('"after"');
  const deleted = parsePatchFiles((await diff(root, "deleted.txt")).content)[0].files[0];
  expect(deleted.type).toBe("deleted");
  const added = await diff(root, "new/[one].ts");
  expect(added.newFile?.contents).toBe("const one = 1;\n");
  expect(parseDiffFromFile(null, added.newFile!).type).toBe("new");
  expect((await diff(root, "new/empty.txt")).newFile?.contents).toBe("");
});
