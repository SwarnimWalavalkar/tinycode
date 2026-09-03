import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import type { Task, ServerPacket } from "../shared/contracts.js";

interface Shell {
  id: string;
  taskId: string;
  process: pty.IPty;
  buffer: string;
  listeners: Set<(p: ServerPacket) => void>;
}
export class Terminals {
  private shells = new Map<string, Shell>();
  attach(task: Task, cols: number, rows: number, send: (p: ServerPacket) => void) {
    this.detach(send);
    let shell = [...this.shells.values()].find((s) => s.taskId === task.id);
    if (!shell) {
      const command =
        process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
      const env = { ...process.env };
      delete env.TINYCODE_TOKEN;
      const processShell = pty.spawn(command, process.platform === "win32" ? [] : ["-l"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: task.cwd,
        env: env as Record<string, string>,
      });
      shell = {
        id: randomUUID(),
        taskId: task.id,
        process: processShell,
        buffer: "",
        listeners: new Set(),
      };
      const current = shell;
      this.shells.set(current.id, current);
      processShell.onData((data) => {
        current.buffer = (current.buffer + data).slice(-128 * 1024);
        for (const listener of current.listeners)
          listener({ type: "terminal.output", terminalId: current.id, data });
      });
      processShell.onExit(({ exitCode }) => {
        for (const listener of current.listeners)
          listener({ type: "terminal.exit", terminalId: current.id, code: exitCode });
        this.shells.delete(current.id);
      });
    }
    shell.listeners.add(send);
    send({ type: "terminal.ready", terminalId: shell.id, taskId: task.id });
    if (shell.buffer) send({ type: "terminal.output", terminalId: shell.id, data: shell.buffer });
    return shell.id;
  }
  input(id: string, data: string) {
    this.shells.get(id)?.process.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    this.shells.get(id)?.process.resize(cols, rows);
  }
  close(id: string) {
    const s = this.shells.get(id);
    s?.process.kill();
  }
  detach(send: (p: ServerPacket) => void) {
    for (const shell of this.shells.values()) shell.listeners.delete(send);
  }
  dispose() {
    for (const shell of this.shells.values()) shell.process.kill();
  }
}
