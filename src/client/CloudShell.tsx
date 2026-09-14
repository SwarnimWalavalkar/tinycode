import { useEffect, useRef, useState } from "react";
import { api } from "./state";
export default function CloudShell({
  taskId,
  connected,
  registerGuard,
}: {
  taskId: string;
  connected: boolean;
  registerGuard: (guard: (() => boolean) | null) => void;
}) {
  const [command, setCommand] = useState(""),
    [output, setOutput] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && document.activeElement === document.body && !inputRef.current?.closest("[inert]"))
      inputRef.current?.focus({ preventScroll: true });
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    registerGuard(() => !busy);
    return () => registerGuard(null);
  }, [busy, registerGuard]);
  async function run() {
    if (busy || !command.trim()) return;
    const input = command;
    setCommand("");
    setBusy(true);
    setOutput((o) => `${o}\n$ ${input}\n`);
    try {
      const r = await api<{ stdout: string; stderr: string; exitCode: number }>(
        `/tasks/${taskId}/shell`,
        { method: "POST", body: JSON.stringify({ command: input }) },
      );
      if (alive.current)
        setOutput((o) => (o + r.stdout + r.stderr + `\n[exit ${r.exitCode}]\n`).slice(-200000));
    } catch (e) {
      if (alive.current) setOutput((o) => o + `\n${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="cloud-shell">
      <p>Sandbox shell · /workspace · commands run for up to 30 seconds</p>
      <pre tabIndex={0} aria-label="Shell output">
        {output || "Enter a command to start."}
      </pre>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          ref={inputRef}
          aria-label="Shell command"
          value={command}
          disabled={busy || !connected}
          onChange={(e) => setCommand(e.target.value)}
          autoComplete="off"
        />
        <button disabled={busy || !connected || !command.trim()}>
          {busy ? "Running…" : "Run"}
        </button>
      </form>
    </div>
  );
}
