import { describe, expect, it } from "vitest";
import { assertEquivalent, diff, normalize } from "../src/parity.js";

describe("parity", () => {
  it("is reflexive after normalization", () => {
    const value = {
      at: "2026-01-01T00:00:00Z",
      blocks: [{ id: "a", text: "hello" }, { id: "b", text: "world" }],
      nested: { count: 2, ok: true },
    };
    const normalized = normalize(value, { normalizeTimestamps: true });
    expect(diff(normalized, normalized)).toEqual([]);
  });

  it("ignores timestamp and array order when asked", () => {
    const left = {
      at: "2026-01-01T00:00:00Z",
      items: [{ id: "b" }, { id: "a" }],
    };
    const right = {
      at: "2027-02-02T10:11:12.123Z",
      items: [{ id: "a" }, { id: "b" }],
    };
    expect(() =>
      assertEquivalent(left, right, { normalizeTimestamps: true, sortArrays: true }),
    ).not.toThrow();
  });

  it("reports value, type, and missing fields with JSON-pointer paths", () => {
    const differences = diff(
      { a: 1, nested: { b: "x" }, list: [1, 2] },
      { a: 2, nested: { c: "x" }, list: [1] },
    );
    expect(differences).toEqual(
      expect.arrayContaining([
        { path: "/a", kind: "value", left: 1, right: 2 },
        { path: "/list", kind: "array-length", left: 2, right: 1 },
        { path: "/nested/b", kind: "missing-right", left: "x" },
        { path: "/nested/c", kind: "missing-left", right: "x" },
      ]),
    );
  });

  it("honours ignorePaths", () => {
    const left = { meta: { generatedAt: "2026-01-01T00:00:00Z" }, value: 1 };
    const right = { meta: { generatedAt: "2026-06-01T00:00:00Z" }, value: 1 };
    expect(() =>
      assertEquivalent(left, right, { ignorePaths: ["/meta/*"] }),
    ).not.toThrow();
  });

  it("fails with a readable message", () => {
    expect(() => assertEquivalent({ a: 1 }, { a: 2 })).toThrowError(/\/a: value differs/);
  });
});
