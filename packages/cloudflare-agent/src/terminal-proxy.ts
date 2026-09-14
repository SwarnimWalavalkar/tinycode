/** Keep authentication at the Worker boundary; revoke open connections after sign-out/expiry. */
export function terminalProxy(response: Response, authorized: () => Promise<boolean>) {
  const upstream = response.webSocket;
  if (response.status !== 101 || !upstream) return response;
  const pair = new WebSocketPair();
  const client = pair[1];
  // Workers can deliver binary frames as Blobs. Forward ArrayBuffers so send()
  // preserves the PTY's binary frames instead of coercing them to text.
  client.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";
  client.accept();
  upstream.accept();
  let closed = false;
  const close = (code = 1000, reason = "Terminal disconnected") => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    client.close(code, reason);
    upstream.close(code, reason);
  };
  const timer = setInterval(() => {
    void authorized().then(ok => { if (!ok) close(1008, "Sign in again"); }, () => close(1008, "Authentication unavailable"));
  }, 30_000);
  for (const [source, target] of [[client, upstream], [upstream, client]]) {
    source.addEventListener("message", event => {
      if (closed) return;
      const size = typeof event.data === "string" ? new TextEncoder().encode(event.data).length : event.data.byteLength;
      if (size > 1024 * 1024) { close(1009, "Terminal frame too large"); return; }
      try { target.send(event.data); } catch { close(1011, "Terminal relay failed"); }
    });
    source.addEventListener("close", () => close());
    source.addEventListener("error", () => close(1011, "Terminal connection failed"));
  }
  return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": "tinycode" } });
}
