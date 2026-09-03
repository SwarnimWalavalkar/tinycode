import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { sameOrigin, websocketAuthenticated, unauthenticatedHostAllowed } from "./auth.js";
const request = (headers: IncomingMessage["headers"]) => ({ headers }) as IncomingMessage;

describe("unauthenticated development hosts", () => {
  const devOrigin = "https://dev.example.test:8443";
  const host = new URL(devOrigin).host;

  it("keeps loopback access and admits only the configured dev origin", () => {
    for (const host of ["localhost:4737", "127.0.0.1:4738", "[::1]:4738"])
      expect(unauthenticatedHostAllowed(request({ host }), devOrigin)).toBe(true);
    expect(unauthenticatedHostAllowed(request({ host }))).toBe(false);
    expect(unauthenticatedHostAllowed(request({ host }), devOrigin)).toBe(true);
    expect(unauthenticatedHostAllowed(request({ host, origin: devOrigin }), devOrigin)).toBe(true);
  });

  it("rejects different ports, other hosts, and cross-origin or insecure requests", () => {
    for (const host of [
      "dev.example.test:8444",
      "other.example.test:8443",
      "dev.example.test.evil.com:8443",
      "evil.example",
      "",
    ])
      expect(unauthenticatedHostAllowed(request({ host }), devOrigin)).toBe(false);
    for (const origin of [devOrigin.replace("https:", "http:"), "https://evil.example", "null"])
      expect(unauthenticatedHostAllowed(request({ host, origin }), devOrigin)).toBe(false);
  });

  it("does not trust forwarded headers as proof of authentication", () => {
    expect(
      unauthenticatedHostAllowed(
        request({
          host: "evil.example",
          "x-forwarded-host": host,
          "x-forwarded-proto": "https",
        }),
        devOrigin,
      ),
    ).toBe(false);
  });
});

describe("separate frontend access", () => {
  it("accepts only explicitly allowed frontend origins alongside the server origin", () => {
    const origins = ["http://localhost:4737"];
    const allowed = (origin: string) =>
      sameOrigin(request({ host: "server:4738", origin }), "https://server.example", origins);
    expect(allowed("http://localhost:4737")).toBe(true);
    expect(allowed("https://server.example")).toBe(true);
    for (const origin of [
      "http://localhost:9000",
      "https://evil.example",
      "null",
      "http://localhost:4737/evil",
      "https://user:password@server.example",
    ])
      expect(allowed(origin)).toBe(false);
  });
  it("authenticates browser WebSockets without cookies and rejects an invalid explicit credential", () => {
    const token = "test-token-12345678901234567890";
    const protocol = (value: string) =>
      `tinycode, tinycode.auth.${Buffer.from(value).toString("base64url")}`;
    expect(
      websocketAuthenticated(request({ "sec-websocket-protocol": protocol(token) }), token),
    ).toBe(true);
    expect(
      websocketAuthenticated(
        request({ "sec-websocket-protocol": protocol("wrong"), cookie: `tinycode=${token}` }),
        token,
      ),
    ).toBe(false);
    expect(
      websocketAuthenticated(
        request({ "sec-websocket-protocol": "tinycode, tinycode.auth.%%%" }),
        token,
      ),
    ).toBe(false);
    expect(websocketAuthenticated(request({ "sec-websocket-protocol": "tinycode" }), token)).toBe(
      false,
    );
    expect(websocketAuthenticated(request({ cookie: `tinycode=${token}` }), token)).toBe(true);
  });
});
