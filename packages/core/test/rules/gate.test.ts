import { describe, expect, it } from "vitest";
import { parseRulesFile, RULES_END, RULES_START } from "../../src/rules/index.js";
import {
  compileGate,
  evaluateGate,
  parseGateYaml,
  renderGateYaml,
} from "../../src/rules/gate.js";
import { buildVerdictFile } from "../../src/rules/verdict.js";

const RULES = parseRulesFile(
  "rules.md",
  `${RULES_START}
| ID | Rule | Scope | Severity | Check | Fix | Status | Rationale |
|---|---|---|---|---|---|---|---|
| R-HIGH | One | packages/cli/** | high | agent | report | verified | x |
| R-CRIT | Two | packages/cli/** | critical | auto | mechanical | verified | y |
${RULES_END}
`,
);

describe("fifth-level gate", () => {
  it("blocks protected paths", () => {
    const gate = compileGate(RULES);
    const result = evaluateGate({
      gate,
      rules: RULES,
      changedPaths: [".phronia/config.yaml", "packages/cli/src/a.ts"],
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      "gate.protected_path",
    );
  });

  it("blocks missing verdicts for high and critical rules", () => {
    const gate = compileGate(RULES);
    const verdict = buildVerdictFile("task", [], RULES).file;
    const result = evaluateGate({ gate, rules: RULES, verdict });
    expect(result.allowed).toBe(false);
    expect(result.violations.filter((v) => v.code === "gate.missing_verdict")).toHaveLength(2);
    expect(result.coverage).toBe(0);
  });

  it("passes when every verified rule has a verdict and no rule failed", () => {
    const gate = compileGate(RULES);
    const verdict = buildVerdictFile(
      "task",
      [
        { id: "R-HIGH", status: "pass" },
        { id: "R-CRIT", status: "skipped" },
      ],
      RULES,
    ).file;
    const result = evaluateGate({ gate, rules: RULES, verdict });
    expect(result.allowed).toBe(false);
    // skipped is not evaluated
    expect(result.coverage).toBe(0.5);

    const complete = buildVerdictFile(
      "task",
      [
        { id: "R-HIGH", status: "pass" },
        { id: "R-CRIT", status: "pass" },
      ],
      RULES,
    ).file;
    expect(
      evaluateGate({ gate, rules: RULES, verdict: complete }).allowed,
    ).toBe(true);
  });

  it("blocks a failed critical rule with evidence", () => {
    const gate = compileGate(RULES);
    const verdict = buildVerdictFile(
      "task",
      [
        { id: "R-HIGH", status: "pass" },
        { id: "R-CRIT", status: "fail", evidence: "lint failed" },
      ],
      RULES,
    ).file;
    const result = evaluateGate({ gate, rules: RULES, verdict });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gate.rule_failed", ruleId: "R-CRIT" }),
      ]),
    );
  });

  it("round-trips the generated gate YAML", () => {
    const gate = compileGate(RULES, { now: new Date("2026-10-21T00:00:00Z") });
    const parsed = parseGateYaml(renderGateYaml(gate));
    expect(parsed?.protectedPaths).toEqual(gate.protectedPaths);
    expect(parsed?.requireVerdictCoverage).toBe(1);
    expect(parsed?.postEditChecks).toContain("phronia rules gate --changed");
  });
});
