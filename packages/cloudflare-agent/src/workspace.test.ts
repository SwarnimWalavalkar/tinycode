import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceCommand } from "./workspace";
const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tc-workspace-"));
  dirs.push(root);
  return root;
}
function run(
  root: string,
  action: string,
  path = "",
  input: Record<string, unknown> = {},
) {
  const command = workspaceCommand(action, path, input);
  const parts = [...command.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  const script = Buffer.from(parts[0], "base64")
    .toString()
    .replace("Path('/workspace')", `Path(${JSON.stringify(root)})`);
  return JSON.parse(
    execFileSync("python3", ["-c", script, parts[1]], { encoding: "utf8" }),
  );
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("reads real files, handles shell metacharacters as data and enforces revisions", () => {
  const root = fixture(),
    path = "a'$(echo nope).txt";
  writeFileSync(join(root, path), "hello");
  const file = run(root, "file", path);
  expect(file.content).toBe("hello");
  expect(run(root, "tree")[0].path).toBe(path);
  expect(
    run(root, "save", path, { content: "world", revision: "stale" }).error,
  ).toContain("changed");
  expect(
    run(root, "save", path, { content: "world", revision: file.revision })
      .content,
  ).toBe("world");
});
it("rejects traversal, escaping symlinks and binary files", () => {
  const root = fixture();
  symlinkSync("/etc", join(root, "escape"));
  writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
  expect(run(root, "file", "../outside").error).toContain("outside");
  expect(run(root, "file", "escape/passwd").error).toContain("outside");
  expect(run(root, "file", "binary").error).toContain("Binary");
});
it("reads git status and untracked diffs", () => {
  const root = fixture();
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "hello.txt"), "hello");
  expect(run(root, "git").files).toEqual([{ path: "hello.txt", status: "??" }]);
  expect(run(root, "diff", "hello.txt").newFile.contents).toBe("hello");
});

it("finds a repository cloned under workspace and uses workspace-relative paths", () => {
  const root = fixture();
  execFileSync("git", ["init", "-q", join(root, "repo")]);
  writeFileSync(join(root, "repo", "new.txt"), "new content");
  expect(run(root, "git").files).toEqual([
    { path: "repo/new.txt", status: "??" },
  ]);
  expect(run(root, "diff", "repo/new.txt").newFile.contents).toBe(
    "new content",
  );
});

it("rejects directory diffs and treats Git pathspec syntax as a literal filename", () => {
  const root = fixture();
  execFileSync("git", ["init", "-q", root]);
  expect(run(root, "diff", "").error).toContain("Choose a file");
  const path = ":(glob)*";
  writeFileSync(join(root, path), "literal");
  expect(run(root, "diff", path).newFile.contents).toBe("literal");
});
