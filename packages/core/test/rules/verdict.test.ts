import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRulesFile } from "../../src/rules/index.js";
import {
  buildVerdictFile,
  readVerdictFile,
  writeVerdictFile,
} from "../../src/rules/verdict.js";
import { RULES_END, RULES_START } from "../../src/rules/index.js";

const RULES = parseRulesFile(
  "rules.md",
  `${RULES_START}
| ID | Rule | Scope | Severity | Check | Fix | Status | Rationale |
|---|---|---|---|---|---|---|---|
| R-1 | One | a/** | high | agent | report | verified | x |
| R-2 | Two | a/** | critical | auto | mechanical | verified | y |
| R-3 | Draft | a/** | low | report | report | draft | z |
${RULES_END}
`,
);

describe("check verdicts", () => {
  it("reports missing verified rules as partial", () => {
    const result = buildVerdictFile("task", [{ id: "R-1", status: "pass" }], RULES);
    expect(result.file.overall).toBe("partial");
    expect(result.file.missing).toEqual(["R-2"]);
  });

  it("fails when any verdict fails", () => {
    const result = buildVerdictFile(
      "task",
      [
        { id: "R-1", status: "pass" },
        { id: "R-2", status: "fail", evidence: "test output" },
      ],
      RULES,
    );
    expect(result.file.overall).toBe("fail");
    expect(result.file.missing).toEqual([]);
  });

  it("reports unknown ids without accepting them", () => {
    const result = buildVerdictFile("task", [{ id: "NOPE", status: "pass" }], RULES);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.file.verdicts).toEqual([]);
  });

  it("skipped rules do not count as evaluated", () => {
    const result = buildVerdictFile(
      "task",
      [
        { id: "R-1", status: "skipped" },
        { id: "R-2", status: "pass" },
      ],
      RULES,
    );
    expect(result.file.missing).toEqual(["R-1"]);
  });

  it("round-trips the verdict file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-verdict-"));
    try {
      const taskDir = path.join(root, ".phronia/tasks/01-01-demo");
      fs.mkdirSync(taskDir, { recursive: true });
      const built = buildVerdictFile(
        ".phronia/tasks/01-01-demo",
        [{ id: "R-1", status: "pass" }],
        RULES,
      );
      writeVerdictFile(root, ".phronia/tasks/01-01-demo", built.file);
      expect(readVerdictFile(root, ".phronia/tasks/01-01-demo")?.overall).toBe(
        "partial",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
