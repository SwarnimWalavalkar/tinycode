import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorConnection } from "./connection-health";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
class TestSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  send = vi.fn();
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  packet(data: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("location", {
    origin: "http://localhost:4737",
    protocol: "http:",
    pathname: "/",
    search: "",
    reload: vi.fn(),
  });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("server selection", () => {
  it("keeps the default proxy and isolates credentials and preferences for each server", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const client = await import("./connection");
    expect(client.connection.url).toBe("http://localhost:4737");
    expect(client.serverStorageKey("tinycode-project")).toBe("tinycode-project");
    sessionStorage.setItem("tinycode-token:https://remote.example", "remote-token");
    await client.serverFetch("/api/bootstrap");
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:4737/api/bootstrap");
    expect(fetch.mock.calls[0][1].headers.has("Authorization")).toBe(false);
    expect(fetch.mock.calls[0][1].credentials).toBe("same-origin");
    await client.serverFetch("/api/images/image", {}, { url: "https://remote.example", name: "" });
    expect(fetch.mock.calls[1][0]).toBe("https://remote.example/api/images/image");
    expect(fetch.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer remote-token");
    expect(fetch.mock.calls[1][1].credentials).toBe("omit");
    await client.serverFetch("/api/bootstrap", {}, { url: "https://other.example", name: "" });
    expect(fetch.mock.calls[2][1].headers.has("Authorization")).toBe(false);
  });
  it("normalizes server URLs and refuses credentials or tokens embedded in URLs", async () => {
    const { normalizeServerUrl } = await import("./connection");
    expect(normalizeServerUrl(" HTTPS://Remote.Example:443/tinycode/ ")).toBe(
      "https://remote.example/tinycode",
    );
    for (const value of [
      "localhost:4738",
      "file:///tmp",
      "https://user:password@server",
      "https://server?token=secret",
      "https://server/#secret",
    ])
      expect(() => normalizeServerUrl(value)).toThrow();
  });
  it("persists the name and URL, scopes tokens to the tab, and drops a previous server's task on switch", async () => {
    const client = await import("./connection");
    client.saveConnection({ url: "https://remote.example", name: "Build machine" }, "remote-token");
    expect(JSON.parse(localStorage.getItem("tinycode-connection")!)).toEqual({
      url: "https://remote.example",
      name: "Build machine",
    });
    expect(localStorage.getItem("tinycode-token:https://remote.example")).toBeNull();
    expect(sessionStorage.getItem("tinycode-token:https://remote.example")).toBe("remote-token");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(location.reload).toHaveBeenCalledOnce();
    vi.resetModules();
    const next = await import("./connection");
    expect(next.connectionLabel()).toBe("Build machine");
    expect(next.serverStorageKey("tinycode-project")).toBe(
      "tinycode-project:https://remote.example",
    );
  });
  it("uses the remote host when no custom name is set", async () => {
    localStorage.setItem(
      "tinycode-connection",
      JSON.stringify({ url: "https://remote.example:8443", name: "" }),
    );
    const client = await import("./connection");
    expect(client.connectionLabel()).toBe("remote.example:8443");
    expect(client.isLocalServer()).toBe(false);
  });
  it("puts WebSocket credentials in the handshake without exposing them in the URL", async () => {
    const Socket = vi.fn();
    vi.stubGlobal("WebSocket", Socket);
    const client = await import("./connection");
    client.openSocket(
      { url: "https://remote.example/tinycode", name: "" },
      "token+with/characters",
    );
    const [url, protocols] = Socket.mock.calls[0];
    expect(url.href).toBe("wss://remote.example/tinycode/socket");
    expect(protocols[0]).toBe("tinycode");
    expect(Buffer.from(protocols[1].slice("tinycode.auth.".length), "base64url").toString()).toBe(
      "token+with/characters",
    );
  });
});

describe("connection health", () => {
  it("requires matching heartbeats, times out an unresponsive connection, and removes timers on cleanup", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestSocket);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    const socket = new TestSocket();
    const healthy = vi.fn(),
      failed = vi.fn();
    const stop = monitorConnection(socket as unknown as WebSocket, healthy, failed);
    socket.open();
    expect(healthy).not.toHaveBeenCalled();
    socket.packet({ type: "bootstrap" });
    socket.packet({ type: "pong", id: 99 });
    expect(healthy).not.toHaveBeenCalled();
    socket.packet({ type: "pong", id: 1 });
    expect(healthy).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(15000);
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "ping", id: 2 }));
    socket.packet({ type: "pong", id: 1 });
    vi.advanceTimersByTime(5000);
    expect(failed).toHaveBeenCalledOnce();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    expect(socket.send).toHaveBeenCalledTimes(2);
  });
  it("checks immediately when returning to the window and times out a stalled handshake", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestSocket);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    const socket = new TestSocket(),
      failed = vi.fn();
    let stop = monitorConnection(socket as unknown as WebSocket, vi.fn(), failed);
    vi.advanceTimersByTime(8000);
    expect(failed).toHaveBeenCalledOnce();
    stop();
    stop = monitorConnection(socket as unknown as WebSocket, vi.fn(), failed);
    socket.open();
    socket.packet({ type: "pong", id: 1 });
    window.dispatchEvent(new Event("focus"));
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "ping", id: 2 }));
    stop();
  });
});
