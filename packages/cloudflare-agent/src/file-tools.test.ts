import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCommand, runFileTool } from "./file-tools.js";
import type { VmRuntime } from "./vm-tools.js";
const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tc-file-tools-"));
  dirs.push(root);
  return root;
}
function run(root: string, input: Record<string, unknown>) {
  const parts = [...fileCommand(input).matchAll(/'([A-Za-z0-9+/=]+)'/g)].map(m => m[1]);
  const script = Buffer.from(parts[0], "base64").toString().replace("Path('/workspace')", `Path(${JSON.stringify(root)})`);
  return JSON.parse(execFileSync("python3", ["-c", script, parts[1]], { encoding: "utf8" }));
}
afterEach(() => { for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("creates literal paths, reads pages and atomically applies disjoint edits", () => {
  const root = fixture(), path = "nested/a'$(echo nope).txt";
  const content = "α one\r\nβ two\r\nγ three\r\n";
  expect(run(root, { action: "edit", mode: "write", path, content }).bytes).toBe(Buffer.byteLength(content));
  chmodSync(join(root, path), 0o755);
  const page = run(root, { action: "read", path, offset: 2, limit: 1 });
  expect(page).toMatchObject({ content: "β two\r\n", nextOffset: 3, truncated: true, totalLines: 3 });
  const edited = run(root, { action: "edit", path, revision: page.revision, edits: [
    { oldText: "one", newText: "ONE" }, { oldText: "three", newText: "THREE" },
  ] });
  expect(edited.replacements).toBe(2);
  expect(edited.diff).toContain("ONE");
  expect(readFileSync(join(root, path), "utf8")).toBe("α ONE\r\nβ two\r\nγ THREE\r\n");
  expect(statSync(join(root, path)).mode & 0o777).toBe(0o755);
  expect(run(root, { action: "edit", mode: "write", path, revision: page.revision, content: "stale" }).error).toContain("changed");
});
it("rejects ambiguous, missing and overlapping edits without partial writes", () => {
  const root = fixture(), path = "file";
  writeFileSync(join(root, path), "alpha alpha beta");
  for (const edits of [
    [{ oldText: "beta", newText: "B" }, { oldText: "missing", newText: "x" }],
    [{ oldText: "alpha", newText: "A" }],
    [{ oldText: "alpha alpha", newText: "A" }, { oldText: "alpha beta", newText: "B" }],
  ]) {
    expect(run(root, { action: "edit", path, edits }).error).toBeTruthy();
    expect(readFileSync(join(root, path), "utf8")).toBe("alpha alpha beta");
  }
});
it("bounds reads and gives an explicit fallback for huge lines", () => {
  const root = fixture();
  writeFileSync(join(root, "many"), "line\n".repeat(250));
  expect(run(root, { action: "read", path: "many" })).toMatchObject({ endLine: 200, nextOffset: 201, truncated: true });
  writeFileSync(join(root, "bytes"), ("🙂".repeat(1000) + "\n").repeat(10));
  const page = run(root, { action: "read", path: "bytes" });
  expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(16384);
  expect(page.nextOffset).toBe(5);
  writeFileSync(join(root, "long"), "a".repeat(17000));
  expect(run(root, { action: "read", path: "long" }).error).toContain("use shell");
  writeFileSync(join(root, "empty"), "");
  expect(run(root, { action: "read", path: "empty" })).toMatchObject({ content: "", totalLines: 0, truncated: false });
});
it("rejects escaping paths, symlinks, binary files and oversized inputs", () => {
  const root = fixture();
  symlinkSync("/etc", join(root, "escape"));
  for (const path of ["../outside", "/etc/passwd", "escape/passwd"])
    for (const action of ["read", "edit"])
      expect(run(root, { action, mode: "write", path, content: "bad" }).error).toContain("outside");
  expect(run(root, { action: "read", path: "." }).error).toContain("Choose a file");
  writeFileSync(join(root, "binary"), Buffer.from([0, 1]));
  expect(run(root, { action: "read", path: "binary" }).error).toContain("Binary");
  expect(() => fileCommand({ action: "edit", path: "x", content: "x".repeat(40000) })).toThrow("too large");
});
it("uses cancellable VM execution and surfaces guest failures", async () => {
  const exec = vi.fn().mockResolvedValue({ success: true, stdout: '{"error":"File changed"}', stderr: "", exitCode: 0 });
  const vm = { exec } as unknown as VmRuntime;
  const signal = new AbortController().signal;
  await expect(runFileTool(vm, { action: "read", path: "file" }, signal)).rejects.toThrow("File changed");
  expect(exec).toHaveBeenCalledWith(expect.any(String), "/workspace", 30000, signal);
});
