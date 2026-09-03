import { describe, expect, it } from "vitest";
import { developmentOrigin } from "./dev-network.js";

describe("development proxy configuration", () => {
  it("keeps development local unless a public origin is explicitly configured", () => {
    expect(developmentOrigin({})).toBeUndefined();
    expect(developmentOrigin({ TINYCODE_DEV_ORIGIN: "  " })).toBeUndefined();
  });

  it("normalizes public origins and preserves custom ports", () => {
    expect(developmentOrigin({ TINYCODE_DEV_ORIGIN: " https://dev.example.test:443/ " })).toBe(
      "https://dev.example.test",
    );
    expect(developmentOrigin({ TINYCODE_DEV_ORIGIN: "https://dev.example.test:8443" })).toBe(
      "https://dev.example.test:8443",
    );
    expect(developmentOrigin({ TINYCODE_DEV_ORIGIN: "http://localhost:8080/" })).toBe(
      "http://localhost:8080",
    );
  });

  it("does not enable the development proxy in production", () => {
    expect(
      developmentOrigin({
        NODE_ENV: "production",
        TINYCODE_DEV_ORIGIN: "https://dev.example.test",
      }),
    ).toBeUndefined();
  });

  it("rejects invalid origins instead of exposing a different address", () => {
    for (const value of [
      "not a URL",
      "null",
      "file:///tmp/app",
      "wss://dev.example.test",
      "https://user:password@dev.example.test",
      "https://*.example.test",
      "https://dev.example.test/path",
      "https://dev.example.test/?token=secret",
      "https://dev.example.test/#fragment",
    ])
      expect(() => developmentOrigin({ TINYCODE_DEV_ORIGIN: value })).toThrow(
        "TINYCODE_DEV_ORIGIN",
      );
  });
});
