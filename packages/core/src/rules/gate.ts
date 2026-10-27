/**
 * Fifth-level gate (`loopControl: full`) — gate as code.
 *
 * Only platforms that own their loop (dsh today) can consume these checks;
 * every other platform receives the same command voluntarily. The gate does
 * not pretend to judge prose: it enforces protected paths and verdict
 * coverage, which are mechanical.
 */

import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import type { Rule } from "./index.js";
import type { CheckVerdictFile, RuleVerdict } from "./verdict.js";
import { globMatches } from "./index.js";

export const GATE_VERSION = 1 as const;

export interface GateConfig {
  version: typeof GATE_VERSION;
  protectedPaths: string[];
  postEditChecks: string[];
  requireVerdictCoverage: number;
  denyOn: string[];
  phaseGates: { before_commit: string[] };
  generatedAt: string;
}

export interface GateViolation {
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  path?: string;
  ruleId?: string;
}

export interface GateResult {
  allowed: boolean;
  coverage: number;
  requiredCoverage: number;
  violations: GateViolation[];
  checkedPaths: string[];
  enforced: boolean;
}

const DEFAULT_PROTECTED = [
  ".phronia/**",
  "docs/architecture.md",
  "docs/requirements.md",
];

export function compileGate(
  rules: readonly Rule[],
  options: { now?: Date } = {},
): GateConfig {
  const protectedPaths = new Set(DEFAULT_PROTECTED);
  for (const rule of rules) {
    if (rule.status !== "verified") continue;
    for (const scope of rule.scope) {
      if (scope.startsWith(".phronia") || scope.startsWith("docs/")) {
        protectedPaths.add(scope);
      }
    }
  }
  return {
    version: GATE_VERSION,
    protectedPaths: [...protectedPaths].sort(),
    postEditChecks: ["phronia rules gate --changed", "phronia rules check --changed"],
    requireVerdictCoverage: 1.0,
    denyOn: [
      "severity>=critical && status=fail",
      "missing_verdict && severity>=high",
    ],
    phaseGates: { before_commit: ["phronia rules verdict --task {task} --check"] },
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

export function renderGateYaml(gate: GateConfig): string {
  return [
    `version: ${gate.version}`,
    "protectedPaths:",
    ...gate.protectedPaths.map((entry) => `  - "${entry}"`),
    "postEditChecks:",
    ...gate.postEditChecks.map((entry) => `  - "${entry}"`),
    `requireVerdictCoverage: ${gate.requireVerdictCoverage}`,
    "denyOn:",
    ...gate.denyOn.map((entry) => `  - "${entry}"`),
    "phaseGates:",
    "  before_commit:",
    ...gate.phaseGates.before_commit.map((entry) => `    - "${entry}"`),
    `generatedAt: ${gate.generatedAt}`,
    "",
  ].join("\n");
}

export function writeGate(root: string, rules: readonly Rule[]): GateConfig {
  const gate = compileGate(rules);
  const target = path.join(root, LAYOUT.paths.gate);
  try {
    fs.writeFileSync(target, renderGateYaml(gate), "utf8");
  } catch {
    // The gate is an enhancement; a read-only checkout must not fail compile.
  }
  return gate;
}

export function readGate(root: string): GateConfig | null {
  try {
    const content = fs.readFileSync(path.join(root, LAYOUT.paths.gate), "utf8");
    return parseGateYaml(content);
  } catch {
    return null;
  }
}

export function parseGateYaml(content: string): GateConfig | null {
  const lines = content.split(/\r?\n/);
  const config: GateConfig = {
    version: GATE_VERSION,
    protectedPaths: [],
    postEditChecks: [],
    requireVerdictCoverage: 1,
    denyOn: [],
    phaseGates: { before_commit: [] },
    generatedAt: "",
  };
  let section: "protectedPaths" | "postEditChecks" | "denyOn" | "before_commit" | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("protectedPaths:")) {
      section = "protectedPaths";
      continue;
    }
    if (line.startsWith("postEditChecks:")) {
      section = "postEditChecks";
      continue;
    }
    if (line.startsWith("denyOn:")) {
      section = "denyOn";
      continue;
    }
    if (line.startsWith("before_commit:")) {
      section = "before_commit";
      continue;
    }
    if (line.startsWith("requireVerdictCoverage:")) {
      config.requireVerdictCoverage = Number(line.split(":")[1] ?? "1") || 0;
      section = null;
      continue;
    }
    if (line.startsWith("generatedAt:")) {
      config.generatedAt = line.slice("generatedAt:".length).trim();
      section = null;
      continue;
    }
    const item = /^-\s*"?([^"]+)"?$/.exec(line);
    if (item && section) {
      if (section === "before_commit") config.phaseGates.before_commit.push(item[1] ?? "");
      else config[section].push(item[1] ?? "");
    }
  }
  if (config.protectedPaths.length === 0) config.protectedPaths = [...DEFAULT_PROTECTED];
  return config;
}

export function protectedPathViolations(
  gate: GateConfig,
  changedPaths: readonly string[],
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const file of changedPaths) {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (gate.protectedPaths.some((pattern) => globMatches(pattern, normalized))) {
      violations.push({
        code: "gate.protected_path",
        severity: "critical",
        message: `protected path changed: ${normalized}`,
        path: normalized,
      });
    }
  }
  return violations;
}

export function verdictCoverage(
  verdict: CheckVerdictFile,
  rules: readonly Rule[],
): { coverage: number; missing: Rule[] } {
  const verified = rules.filter((rule) => rule.status === "verified");
  const evaluated = new Set(
    verdict.verdicts
      .filter((entry) => entry.status !== "skipped")
      .map((entry) => entry.id),
  );
  const missing = verified.filter((rule) => !evaluated.has(rule.id));
  const coverage = verified.length === 0 ? 1 : (verified.length - missing.length) / verified.length;
  return { coverage, missing };
}

export function evaluateGate(input: {
  gate: GateConfig;
  rules: readonly Rule[];
  changedPaths?: readonly string[];
  verdict?: CheckVerdictFile | null;
  verdicts?: readonly RuleVerdict[];
  enforced?: boolean;
}): GateResult {
  const changedPaths = input.changedPaths ?? [];
  const violations = protectedPathViolations(input.gate, changedPaths);
  let coverage = 1;
  const verified = input.rules.filter((rule) => rule.status === "verified");

  const verdict = input.verdict;
  const resolvedVerdicts = verdict?.verdicts ?? input.verdicts;
  if (resolvedVerdicts) {
    const evaluated = new Set(
      resolvedVerdicts.filter((entry) => entry.status !== "skipped").map((entry) => entry.id),
    );
    const missing = verified.filter((rule) => !evaluated.has(rule.id));
    coverage = verified.length === 0 ? 1 : (verified.length - missing.length) / verified.length;
    for (const rule of missing) {
      if (rule.severity === "critical" || rule.severity === "high") {
        violations.push({
          code: "gate.missing_verdict",
          severity: rule.severity,
          message: `missing verdict for ${rule.id} (${rule.severity})`,
          ruleId: rule.id,
        });
      }
    }
    for (const entry of resolvedVerdicts) {
      if (entry.status !== "fail") continue;
      const rule = input.rules.find((candidate) => candidate.id === entry.id);
      if (!rule) continue;
      violations.push({
        code: "gate.rule_failed",
        severity: rule.severity,
        message: `rule failed: ${rule.id}${entry.evidence ? ` — ${entry.evidence}` : ""}`,
        ruleId: rule.id,
      });
    }
  }

  if (coverage < input.gate.requireVerdictCoverage) {
    violations.push({
      code: "gate.coverage",
      severity: "high",
      message: `verdict coverage ${(coverage * 100).toFixed(1)}% is below required ${(input.gate.requireVerdictCoverage * 100).toFixed(1)}%`,
    });
  }

  return {
    allowed: violations.length === 0,
    coverage,
    requiredCoverage: input.gate.requireVerdictCoverage,
    violations,
    checkedPaths: [...changedPaths],
    enforced: input.enforced === true,
  };
}

export function gateReportForDoctor(
  root: string,
  rules: readonly Rule[],
  changedPaths: readonly string[],
): { gate: GateConfig | null; result: GateResult } | null {
  if (rules.length === 0) return null;
  const gate = readGate(root) ?? compileGate(rules);
  return { gate, result: evaluateGate({ gate, rules, changedPaths, enforced: true }) };
}
