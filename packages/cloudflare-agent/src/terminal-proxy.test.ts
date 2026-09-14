import { afterEach, expect, it, vi } from "vitest";
import { terminalProxy } from "./terminal-proxy.js";

class Socket extends EventTarget {
  binaryType = "blob";
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("preserves binary PTY frames in both directions and revokes expired sessions", async () => {
  vi.useFakeTimers();
  const downstream = new Socket();
  const upstream = new Socket();
  vi.stubGlobal("WebSocketPair", class { 0 = new Socket(); 1 = downstream; });
  vi.stubGlobal("Response", class { constructor(_body: unknown, public init: unknown) {} });
  const authorized = vi.fn(async () => true);
  terminalProxy({ status: 101, webSocket: upstream } as unknown as Response, authorized);
  expect(upstream.binaryType).toBe("arraybuffer");
  expect(downstream.binaryType).toBe("arraybuffer");
  const bytes = new TextEncoder().encode("\x1b[32mhello\x03").buffer;
  upstream.dispatchEvent(new MessageEvent("message", { data: bytes }));
  downstream.dispatchEvent(new MessageEvent("message", { data: bytes }));
  expect(downstream.send).toHaveBeenCalledWith(bytes);
  expect(upstream.send).toHaveBeenCalledWith(bytes);
  authorized.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(downstream.close).toHaveBeenCalledWith(1008, "Sign in again");
  expect(upstream.close).toHaveBeenCalledWith(1008, "Sign in again");
  expect(vi.getTimerCount()).toBe(0);
});
