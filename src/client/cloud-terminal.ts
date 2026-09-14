import { connection, openSocket, readToken } from "./connection";

/** Terminal protocol: binary I/O, JSON lifecycle and resize frames. */
export function connectCloudTerminal(input: {
  taskId: string;
  output: (data: Uint8Array | string) => void;
  reset: () => void;
  status: (value: "connecting" | "connected" | "disconnected") => void;
  exit: (code: number) => void;
}) {
  let socket: WebSocket;
  let disposed = false;
  let ready = false;
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let cols = 80, rows = 24;
  const encoder = new TextEncoder();
  const resize = () => {
    if (ready && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
  };
  const connect = () => {
    if (disposed) return;
    ready = false;
    input.status("connecting");
    const current = socket = openSocket(connection, readToken(), `/api/tasks/${encodeURIComponent(input.taskId)}/terminal`);
    current.binaryType = "arraybuffer";
    current.onopen = () => { if (!disposed && socket === current) input.reset(); };
    current.onmessage = event => {
      if (disposed || socket !== current) return;
      if (event.data instanceof ArrayBuffer) { input.output(new Uint8Array(event.data)); return; }
      try {
        const message = JSON.parse(event.data);
        if (message.type === "ready") { ready = true; attempts = 0; input.status("connected"); resize(); }
        else if (message.type === "exit") { disposed = true; input.exit(message.code ?? 0); current.close(); }
        else if (message.type === "error") input.output(`\r\n${message.message}\r\n`);
      } catch { input.output("\r\nInvalid terminal status message\r\n"); }
    };
    current.onerror = () => { /* close schedules bounded reconnect */ };
    current.onclose = () => {
      if (disposed || socket !== current) return;
      ready = false;
      input.status("disconnected");
      if (attempts < 3) retry = setTimeout(connect, 1000 * 2 ** attempts++);
      else input.output("\r\nConnection unavailable. Reconnect after the agent finishes or sign in again.\r\n");
    };
  };
  connect();
  return {
    write(data: string) { if (ready && socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data)); },
    resize(c: number, r: number) { cols = c; rows = r; resize(); },
    dispose() { disposed = true; clearTimeout(retry); socket.close(); },
  };
}
