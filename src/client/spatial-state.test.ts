import { describe, expect, it } from "vitest";
import { initialSpatial, moveSpatial, removeSpatial, restoreSpatial } from "./spatial-state";
describe("spatial layout", () => {
  it("preserves home, caps columns and rejects corrupt stored layouts", () => {
    const s = initialSpatial();
    expect(removeSpatial(s)).toBe(s);
    s.spaces[0].columns.push({ id: "a", kind: "files" }, { id: "b", kind: "files" });
    expect(restoreSpatial(JSON.stringify(s))).toEqual(initialSpatial());
    expect(restoreSpatial("{oops")).toEqual(initialSpatial());
  });
  it("reuses occupied coordinates and does not create on navigation", () => {
    const s = initialSpatial();
    expect(moveSpatial(s, 0, -1, false)).toBe(s);
    const next = moveSpatial(s, 0, -1, true);
    expect(next.spaces).toHaveLength(2);
    expect(moveSpatial(next, 0, 1, true).active).toBe("home");
    expect(moveSpatial(next, 0, 1, true).spaces).toHaveLength(2);
  });
  it("removes workspace without renumbering survivors and restores positions", () => {
    let s = moveSpatial(initialSpatial(), 1, 0, true);
    s = moveSpatial(s, 0, 1, true);
    const third = s.active;
    s = moveSpatial(s, 0, -1, false);
    s = removeSpatial(s);
    expect(s.spaces.find((w) => w.id === third)?.number).toBe(3);
    expect(restoreSpatial(JSON.stringify(s))).toEqual(s);
  });
  it("rejects duplicate coordinates, chat copies and terminals that share a socket", () => {
    const s = moveSpatial(initialSpatial(), 1, 0, true);
    s.spaces[1].x = 0;
    expect(restoreSpatial(JSON.stringify(s))).toEqual(initialSpatial());
    s.spaces[1].x = 1;
    s.spaces[1].columns = [{ id: "copy", kind: "chat" }];
    expect(restoreSpatial(JSON.stringify(s))).toEqual(initialSpatial());
    s.spaces[1].columns = [
      { id: "a", kind: "terminal" },
      { id: "b", kind: "terminal" },
    ];
    expect(restoreSpatial(JSON.stringify(s))).toEqual(initialSpatial());
  });
});

describe("canvas layouts", () => {
  it("restores separate canvases and retains closed boards in the catalog", () => {
    const s = moveSpatial(initialSpatial(), 1, 0, true);
    s.canvases = [{ id: "a", name: "Canvas 1" }, { id: "b", name: "Canvas 2" }];
    s.spaces[1].columns = [{ id: "a", kind: "canvas" }, { id: "b", kind: "canvas" }];
    expect(restoreSpatial(JSON.stringify(s))).toEqual(s);
    s.spaces[1].columns = [];
    expect(restoreSpatial(JSON.stringify(s)).canvases).toEqual(s.canvases);
  });
  it("rejects malformed or duplicate saved canvas entries", () => {
    const s = initialSpatial();
    s.canvases = [{ id: "a", name: "Canvas 1" }, { id: "a", name: "Canvas 2" }];
    expect(restoreSpatial(JSON.stringify(s))).toEqual(initialSpatial());
    expect(restoreSpatial(JSON.stringify({ ...s, canvases: [null] }))).toEqual(initialSpatial());
  });
});
