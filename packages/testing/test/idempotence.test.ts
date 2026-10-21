import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareDrift,
  loadBaseline,
  parseUpdateDryRun,
  runUpdateDryRun,
  structuralDrift,
} from "../src/idempotence.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const BASELINE = path.join(REPO_ROOT, "packages/testing/baselines/dogfood-drift.json");

describe("idempotence report parsing", () => {
  it("classifies every dry-run section", () => {
    const report = parseUpdateDryRun(
      [
        "Scanning for changes...",
        "  New files (will add):",
        "    + .claude/agents/new.md",
        "  Template updated (will auto-update):",
        "    ↑ .phronia/scripts/task.py",
        "  Unchanged files (will skip):",
        "    ○ .phronia/scripts/__init__.py",
        "    ... and 239 more",
        "  Modified by you (need your decision):",
        "    ? .phronia/config.yaml",
        "  Deleted by you (preserved):",
        "    ✕ .opencode/package.json",
        "  User data (preserved):",
        "    ○ .phronia/spec/",
        "This will UPGRADE: 0.6.14 → 0.6.17",
      ].join("\n"),
    );

    expect(report.newFiles).toEqual([".claude/agents/new.md"]);
    expect(report.templateUpdated).toEqual([".phronia/scripts/task.py"]);
    expect(report.modified).toEqual([".phronia/config.yaml"]);
    expect(report.deleted).toEqual([".opencode/package.json"]);
    expect(report.userData).toEqual([".phronia/spec"]);
    expect(report.upgrade).toBe("0.6.14 → 0.6.17");
  });

  it("strips ANSI colour codes", () => {
    const report = parseUpdateDryRun(
      ["  Modified by you (need your decision):", "    \u001b[33m?\u001b[39m .phronia/workflow.md"].join(
        "\n",
      ),
    );
    expect(report.modified).toEqual([".phronia/workflow.md"]);
  });
});

describe.skipIf(!existsSync(CLI_ENTRY))("dogfood idempotence", () => {
  it(
    "has no structural drift and no unexpected user drift",
    async () => {
      const report = runUpdateDryRun(REPO_ROOT);
      expect(report.exitCode, report.raw.slice(-2_000)).toBe(0);

      expect(structuralDrift(report)).toEqual([]);

      const baseline = await loadBaseline(BASELINE);
      const comparison = compareDrift(report, baseline);
      expect(
        comparison.newDrift,
        `New drift. Either fix the template/dogfood mismatch or record it intentionally:\n${comparison.newDrift.join("\n")}`,
      ).toEqual([]);
      expect(
        comparison.resolvedDrift,
        `Known drift disappeared. Update packages/testing/baselines/dogfood-drift.json:\n${comparison.resolvedDrift.join("\n")}`,
      ).toEqual([]);
    },
    120_000,
  );
});
