import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
export const git = async (cwd: string, args: string[]) =>
  (
    await exec("git", ["--no-pager", ...args], {
      cwd,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout;
export async function gitInfo(cwd: string, rootOnly = false) {
  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
    if (rootOnly) {
      const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
      if ((await realpath(root)) !== (await realpath(cwd))) return { isGit: false, branch: null };
    }
    let branch: string | null = null;
    try {
      branch = (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
    } catch {
      branch = "detached";
    }
    return { isGit: true, branch };
  } catch {
    return { isGit: false, branch: null };
  }
}
export async function containedPath(root: string, path: string) {
  const base = await realpath(root);
  const candidate = await realpath(resolve(base, path));
  const rel = relative(base, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Path is outside this workspace");
  if (rel.split(sep).includes(".git")) throw new Error("Git internal files are not editable");
  return candidate;
}
export async function tree(root: string, path = "") {
  const directory = await containedPath(root, path);
  return (await readdir(directory, { withFileTypes: true }))
    .filter((e) => ![".git", "node_modules", ".tinycode"].includes(e.name))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .slice(0, 1000)
    .map((e) => ({
      name: e.name,
      path: [path, e.name].filter(Boolean).join("/"),
      type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "file",
    }));
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function file(root: string, path: string) {
  const full = await containedPath(root, path);
  const info = await stat(full);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error("Preview is limited to text files up to 1 MB");
  const buffer = await readFile(full);
  if (buffer.includes(0)) throw new Error("Binary files cannot be previewed");
  const content = buffer.toString("utf8");
  return { path, content, revision: hash(content) };
}
export async function saveFile(root: string, path: string, content: string, revision: string) {
  const current = await file(root, path);
  if (current.revision !== revision)
    throw new Error("This file changed on disk. Reopen it before saving.");
  await writeFile(await containedPath(root, path), content, "utf8");
  return { path, content, revision: hash(content) };
}
export async function gitStatus(cwd: string, rootOnly = false) {
  const info = await gitInfo(cwd, rootOnly);
  if (!info.isGit) return { ...info, files: [] };
  const parts = (
    await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
  ).split("\0");
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const status = p.slice(0, 2);
    files.push({ path: p.slice(3), status });
    if (status.includes("R") || status.includes("C")) i++;
  }
  return { ...info, files };
}
export async function diff(cwd: string, path: string, rootOnly = false) {
  if (rootOnly && !(await gitInfo(cwd, true)).isGit)
    throw new Error("No Git repository in this workspace");
  // Pathspecs are literal: file names must never become git pathspec expressions.
  if (!path || path.includes("\0")) throw new Error("Choose a file");
  const pathspec = `:(literal)${path}`;
  const output = await git(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "HEAD",
    "--",
    pathspec,
  ]).catch(async () => git(cwd, ["diff", "--no-ext-diff", "--no-color", "--", pathspec]));
  if (output) return { content: output };
  const staged = await git(cwd, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-color",
    "--",
    pathspec,
  ]);
  if (staged) return { content: staged };
  const content = await file(cwd, path);
  return {
    content: content.content
      .split("\n")
      .map((line) => "+" + line)
      .join("\n"),
  };
}
