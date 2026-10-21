import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileRules,
  globMatches,
  parseRulesFile,
  rulesForPath,
  RULES_END,
  RULES_START,
} from "../../src/rules/index.js";

const VALID = `${RULES_START}
| ID | Rule | Scope | Severity | Check | Fix | Status | Rationale |
|---|---|---|---|---|---|---|---|
| CLI-BE-001 | Errors must bubble to the top-level catch | \`packages/cli/src/**/*.ts\` | high | auto | report | verified | error-handling.md |
| CLI-BE-002 | Writes must use atomic-write | \`packages/cli/src/**\` | critical | auto | mechanical | verified | filesystem-safety.md |
| CLI-BE-003 | New platforms register capabilities | \`packages/cli/src/configurators/**\` | medium | agent | report | draft | platform-integration.md |
${RULES_END}
`;

describe("rule ledger parsing", () => {
  it("parses a rules table", () => {
    const diagnostics: { code: string }[] = [];
    const rules = parseRulesFile(".phronia/spec/cli/backend/rules.md", VALID, diagnostics as never);
    expect(diagnostics).toEqual([]);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({
      id: "CLI-BE-001",
      severity: "high",
      check: "auto",
      fix: "report",
      status: "verified",
      scope: ["packages/cli/src/**/*.ts"],
    });
  });

  it("rejects duplicate ids", () => {
    const duplicated = VALID.replace("CLI-BE-002", "CLI-BE-001");
    const diagnostics: { code: string }[] = [];
    parseRulesFile("rules.md", duplicated, diagnostics as never);
    expect(diagnostics.map((item) => item.code)).toContain("rules.duplicate_id");
  });

  it("rejects an invalid severity", () => {
    const diagnostics: { code: string }[] = [];
    parseRulesFile("rules.md", VALID.replace("| high |", "| urgent |"), diagnostics as never);
    expect(diagnostics.map((item) => item.code)).toContain("rules.invalid_value");
  });

  it("ignores files without a rules block", () => {
    expect(parseRulesFile("plain.md", "# Just prose\n")).toEqual([]);
  });
});

describe("rule scope matching", () => {
  it("matches ** and * globs", () => {
    expect(globMatches("packages/cli/src/**/*.ts", "packages/cli/src/a/b.ts")).toBe(true);
    expect(globMatches("packages/cli/src/*.ts", "packages/cli/src/a/b.ts")).toBe(false);
    expect(globMatches("packages/cli/src/**", "packages/cli/src/a/b.ts")).toBe(true);
  });

  it("returns only verified matching rules, strongest first", () => {
    const rules = parseRulesFile("rules.md", VALID);
    const matched = rulesForPath(rules, "packages/cli/src/configurators/new.ts");
    expect(matched.map((rule) => rule.id)).toEqual(["CLI-BE-002", "CLI-BE-001"]);
  });
});

describe("compileRules", () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("walks spec directories and hashes the sources", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-rules-"));
    const specDir = path.join(root, ".phronia/spec/cli/backend");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "rules.md"), VALID);
    const compiled = compileRules(root, { now: new Date("2026-10-21T00:00:00Z") });
    expect(compiled.rules).toHaveLength(3);
    expect(compiled.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compiled.generatedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(compiled.diagnostics).toEqual([]);
  });
});
