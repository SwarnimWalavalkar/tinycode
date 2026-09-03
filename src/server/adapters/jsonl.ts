import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Bounded JSONL framing shared by the two native RPC transports. */
export class JsonLines {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private ended = false;
  private closing = false;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  onMessage: (message: Record<string, any>) => void = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(command: string, args: string[], cwd: string, maxFrameBytes = 8 * 1024 * 1024) {
    const env = { ...process.env };
    delete env.TINYCODE_TOKEN;
    this.child = spawn(command, args, { cwd, env, stdio: "pipe", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdin.on("error", (e) => this.finish(e));
    this.child.stderr.on("data", (s: string) => {
      this.stderr = (this.stderr + s).slice(-8192);
    });
    this.child.stdout.on("data", (s: string) => {
      this.buffer += s;
      if (this.buffer.length > maxFrameBytes) {
        this.finish(new Error("Harness exceeded the protocol frame limit"));
        this.dispose();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let m: Record<string, any>;
        try {
          m = JSON.parse(line);
          if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("Invalid frame");
        } catch {
          this.finish(new Error("Harness emitted invalid JSON"));
          this.dispose();
          return;
        }
        const pending = this.pending.get(String(m.id));
        if (pending && !m.method && ("result" in m || "error" in m || m.type === "response")) {
          clearTimeout(pending.timer);
          this.pending.delete(String(m.id));
          if (m.error || m.success === false)
            pending.reject(
              new Error(
                typeof m.error === "string"
                  ? m.error
                  : (m.error?.message ?? "Harness request failed"),
              ),
            );
          else pending.resolve(m.type === "response" ? m.data : m.result);
        } else {
          try {
            this.onMessage(m);
          } catch (error) {
            this.finish(error instanceof Error ? error : new Error(String(error)));
            this.dispose();
            return;
          }
        }
      }
    });
    this.child.on("error", (e) => this.finish(e));
    this.child.on("close", (code, signal) =>
      this.finish(
        new Error(
          `Harness exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
        ),
      ),
    );
  }
  private finish(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.onExit(error);
  }
  send(message: object) {
    if (this.ended) throw new Error("Harness process is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(message: object, timeout = 30000): Promise<any> {
    if (this.ended) return Promise.reject(new Error("Harness process is closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Harness did not acknowledge the request"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, ...message });
    });
  }
  dispose() {
    if (this.closing) return;
    this.closing = true;
    this.finish(new Error("Harness closed"));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}
