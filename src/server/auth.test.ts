import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { sameOrigin, websocketAuthenticated } from "./auth.js";
const request = (headers: IncomingMessage["headers"]) => ({ headers }) as IncomingMessage;

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
