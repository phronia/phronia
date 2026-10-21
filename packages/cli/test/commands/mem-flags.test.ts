import { describe, expect, it, vi } from "vitest";
import { buildFilter, parseArgv } from "../../src/commands/mem.js";

describe("mem argv parsing", () => {
  it("accepts single-dash flags such as -h", () => {
    expect(parseArgv(["list", "-h"])).toMatchObject({ cmd: "list", flags: { h: true } });
  });

  it("does not treat a negative number as a flag value boundary", () => {
    expect(parseArgv(["list", "--limit", "-5"]).flags.limit).toBe(true);
  });

  it("keeps positional arguments after flags", () => {
    const argv = parseArgv(["search", "--platform", "claude", "memory", "floor"]);
    expect(argv.positional).toEqual(["memory", "floor"]);
  });
});

describe("mem filters", () => {
  it("preserves an explicit --until time", () => {
    const filter = buildFilter({ until: "2026-04-01T12:00:00Z" });
    expect(filter.until?.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("expands a date-only --until to end of day", () => {
    const filter = buildFilter({ until: "2026-04-01" });
    expect(filter.until?.toISOString()).toBe("2026-04-01T23:59:59.999Z");
  });

  it("rejects a negative limit", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => buildFilter({ limit: "-5" })).toThrow("exit");
      expect(error).toHaveBeenCalledWith("error: --limit must be at least 1");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
