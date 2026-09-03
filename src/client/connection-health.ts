// Application-level heartbeats work in browsers, which cannot send WebSocket
// ping frames. Only a matching server response makes the connection healthy.
export function monitorConnection(socket: WebSocket, onHealthy: () => void, onTimeout: () => void) {
  let sequence = 0;
  let pending: number | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline = setTimeout(onTimeout, 8000);
  function check() {
    if (socket.readyState !== WebSocket.OPEN || pending !== null) return;
    pending = ++sequence;
    socket.send(JSON.stringify({ type: "ping", id: pending }));
    clearTimeout(deadline);
    deadline = setTimeout(onTimeout, 5000);
  }
  const open = () => {
    check();
    interval = setInterval(check, 15000);
  };
  const message = (event: MessageEvent) => {
    try {
      const packet = JSON.parse(event.data);
      if (packet.type === "pong" && pending !== null && packet.id === pending) {
        clearTimeout(deadline);
        pending = null;
        onHealthy();
      }
    } catch {}
  };
  const visible = () => {
    if (document.visibilityState === "visible") check();
  };
  socket.addEventListener("open", open);
  socket.addEventListener("message", message);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", visible);
  return () => {
    clearTimeout(deadline);
    clearInterval(interval);
    socket.removeEventListener("open", open);
    socket.removeEventListener("message", message);
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", visible);
  };
}
