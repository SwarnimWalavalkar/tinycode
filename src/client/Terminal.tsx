import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSquare, X } from "lucide-react";
import { onTerminal, sendSocket } from "./state";

export default function Terminal({
  taskId,
  connected,
  onHide,
}: {
  taskId: string;
  connected: boolean;
  onHide: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminalId = useRef<string | null>(null);
  const [exited, setExited] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let active = true;
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
    // Fit the terminal with the real glyph widths on its first frame, including
    // when the font has not been needed elsewhere in the UI yet.
    void Promise.all([
      document.fonts.load(`12px ${fontFamily}`),
      document.fonts.load(`700 12px ${fontFamily}`),
      document.fonts.load(`italic 12px ${fontFamily}`),
    ])
      .catch(() => {})
      .then(() => {
        if (active) setFontReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!host.current || !connected || !fontReady) return;
    setExited(false);
    terminalId.current = null;
    const terminal = new XTerm({
      fontFamily: getComputedStyle(host.current).getPropertyValue("--mono").trim(),
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: "#242522",
        foreground: "#dedfd5",
        cursor: "#e9ba83",
        selectionBackground: "#5e605766",
        black: "#242522",
        red: "#e68b7c",
        green: "#b7cc91",
        yellow: "#e6ce96",
        blue: "#a3c2cb",
        magenta: "#d2acd0",
        cyan: "#9ec7b5",
        white: "#e9e7dd",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    const off = onTerminal((p) => {
      if (p.type === "terminal.ready" && p.taskId === taskId) {
        terminalId.current = p.terminalId;
        terminal.reset();
      }
      if (p.type === "terminal.output" && p.terminalId === terminalId.current)
        terminal.write(p.data);
      if (p.type === "terminal.exit" && p.terminalId === terminalId.current) {
        terminal.writeln(`\r\n[Process exited with code ${p.code}]`);
        setExited(true);
      }
    });
    sendSocket({ type: "terminal.create", taskId, cols: terminal.cols, rows: terminal.rows });
    const input = terminal.onData((data) => {
      if (terminalId.current)
        sendSocket({ type: "terminal.input", terminalId: terminalId.current, data });
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fit.fit();
        if (terminalId.current)
          sendSocket({
            type: "terminal.resize",
            terminalId: terminalId.current,
            cols: terminal.cols,
            rows: terminal.rows,
          });
      });
    });
    observer.observe(host.current);
    terminal.focus();
    return () => {
      sendSocket({ type: "terminal.detach" });
      observer.disconnect();
      cancelAnimationFrame(frame);
      off();
      input.dispose();
      terminal.dispose();
    };
  }, [taskId, connected, generation, fontReady]);
  return (
    <section className="terminal-pane">
      <header>
        <span>
          <TerminalSquare size={14} /> Terminal <i>server shell</i>
        </span>
        <div>
          {exited ? (
            <button onClick={() => setGeneration((g) => g + 1)}>Restart</button>
          ) : (
            <button
              onClick={() => {
                if (terminalId.current)
                  sendSocket({ type: "terminal.close", terminalId: terminalId.current });
              }}
            >
              End session
            </button>
          )}
          <button
            aria-label="Hide terminal"
            title="Hide terminal; process keeps running"
            onClick={onHide}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div ref={host} className="terminal-surface" />
      {!connected && <div className="terminal-disconnected">Reconnecting to terminal…</div>}
    </section>
  );
}
