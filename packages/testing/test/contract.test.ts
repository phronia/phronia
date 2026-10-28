import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffShape, replayFixture, shapeOf } from "../src/contract.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/dist/cli/index.js");
const FIXTURES = path.join(REPO_ROOT, "packages/testing/fixtures/contract");

describe("shape diffing", () => {
  it("flattens nested objects and arrays", () => {
    expect(
      shapeOf({ a: 1, b: { c: true }, list: [{ id: "x" }] }),
    ).toEqual(["a", "b.c", "list[].id"]);
  });

  it("reports missing and extra keys independently", () => {
    expect(diffShape(["a", "b", "c"], ["a", "c", "d"])).toEqual({
      missing: ["b"],
      extra: ["d"],
    });
  });
});

describe.skipIf(!existsSync(CLI_ENTRY))("contract fixture replay", () => {
  it(
    "replays the OpenCode session-start fixture without shape drift",
    async () => {
      const result = await replayFixture(
        path.join(FIXTURES, "opencode-v1-session-start"),
        { cliPath: CLI_ENTRY },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.payloadShape).toEqual({ missing: [], extra: [] });
      expect(result.responseShape).toEqual({ missing: [], extra: [] });
      const response = result.response as {
        event: string;
        platform: string;
        session: { task: string | null };
        blocks: unknown[];
      };
      expect(response.event).toBe("session-start");
      expect(response.platform).toBe("opencode");
      expect(response.session.task).toContain("demo-task");
      expect(response.blocks.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it("detects a payload key that the fixture did not record", () => {
    const drift = diffShape(["sessionID"], shapeOf({ sessionID: "demo", newKey: 1 }));
    expect(drift.extra).toEqual(["newKey"]);
  });

  it(
    "replays the OpenCode v2 context fixture with the reported adapter",
    async () => {
      const result = await replayFixture(
        path.join(FIXTURES, "opencode-v2-session-context"),
        { cliPath: CLI_ENTRY },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.payloadShape).toEqual({ missing: [], extra: [] });
      expect(result.responseShape).toEqual({ missing: [], extra: [] });
      const response = result.response as {
        event: string;
        platform: string;
        session: { task: string | null };
        blocks: unknown[];
      };
      expect(response.event).toBe("session-start");
      expect(response.platform).toBe("opencode");
      expect(response.session.task).toContain("demo-task");
      expect(response.blocks.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
