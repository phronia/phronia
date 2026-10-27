import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listFloorRecords,
  parseJournal,
  searchFloor,
} from "../../src/mem/floor.js";

describe("memory floor", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-floor-"));
    fs.mkdirSync(path.join(root, ".phronia/workspace/alice"), { recursive: true });
    fs.mkdirSync(path.join(root, ".phronia/tasks/10-20-mem-floor"), { recursive: true });
    fs.mkdirSync(path.join(root, ".phronia/spec/cli/backend"), { recursive: true });

    fs.writeFileSync(
      path.join(root, ".phronia/workspace/alice/journal-1.md"),
      [
        "# Development Journal",
        "",
        "## Session 1: Fix memory recall",
        "**Date**: 2026-10-20",
        "**Task**: Memory floor",
        "**Branch**: feature/mem",
        "",
        "### Summary",
        "",
        "We fixed the recall pipeline and added a floor reader.",
        "",
        "### Next Steps",
        "",
        "- benchmark the search",
        "",
        "## Session 2: Unrelated cleanup",
        "**Date**: 2026-10-21",
        "",
        "Updated formatting only.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, ".phronia/tasks/10-20-mem-floor/task.json"),
      JSON.stringify({
        id: "10-20-mem-floor",
        title: "Memory floor",
        status: "in_progress",
        description: "Make journals and tasks recallable.",
      }),
    );
    fs.writeFileSync(
      path.join(root, ".phronia/tasks/10-20-mem-floor/prd.md"),
      "# PRD\n\nThe floor is always available.",
    );
    fs.writeFileSync(
      path.join(root, ".phronia/spec/cli/backend/design.md"),
      "# Design\n\n## Recall pipeline\n\nThe floor partitions results from enhancers.\n",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists journals, tasks, and spec sections", () => {
    const { records, warnings } = listFloorRecords(root);
    expect(warnings).toEqual([]);
    expect(records.filter((record) => record.kind === "journal")).toHaveLength(2);
    expect(records.filter((record) => record.kind === "task-summary")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "spec")).toHaveLength(1);
    const spec = records.find((record) => record.kind === "spec");
    expect(spec?.id).toBe("spec:.phronia/spec/cli/backend/design.md#recall-pipeline");
  });

  it("scores title hits above body hits and keeps excerpts", () => {
    const result = searchFloor(root, "memory floor");
    expect(result.hits[0]?.record.kind).toBe("task-summary");
    expect(result.hits[0]?.score).toBeGreaterThanOrEqual(5);
    expect(result.hits[0]?.snippet.toLowerCase()).toContain("memory floor");
  });

  it("filters by kind", () => {
    const result = searchFloor(root, "recall", { kinds: ["journal"] });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.record.kind).toBe("journal");
  });

  it("parses session fields without leaking the next session", () => {
    const content = fs.readFileSync(
      path.join(root, ".phronia/workspace/alice/journal-1.md"),
      "utf8",
    );
    const records = parseJournal(root, "alice", "journal-1.md", content);
    expect(records).toHaveLength(2);
    expect(records[0]?.createdAt).toBe("2026-10-20");
    expect(records[0]?.branch).toBe("feature/mem");
    expect(records[0]?.text).not.toContain("Unrelated cleanup");
  });

  it("returns an empty result for an empty query", () => {
    expect(searchFloor(root, "   ")).toMatchObject({ hits: [], total: 0 });
  });
});
