/**
 * Specification rule ledger.
 *
 * Prose specs explain why; `rules.md` records only constraints that can be
 * answered with "violated / not violated". Compilation produces a machine
 * projection used by JIT injection and check verdicts. Draft rules are
 * reported but never enforced.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "../layout/index.js";

export const RULES_START = "<!-- phronia:rules:start -->";
export const RULES_END = "<!-- phronia:rules:end -->";
export const RULES_SCHEMA_VERSION = 1 as const;

export type RuleSeverity = "critical" | "high" | "medium" | "low";
export type RuleCheck = "auto" | "agent" | "report";
export type RuleFix = "mechanical" | "report";
export type RuleStatus = "draft" | "verified" | "deprecated";

export interface Rule {
  id: string;
  statement: string;
  scope: string[];
  severity: RuleSeverity;
  check: RuleCheck;
  fix: RuleFix;
  status: RuleStatus;
  rationale: string;
  source: { path: string; line: number };
}

export interface RuleDiagnostic {
  code: string;
  severity: "error" | "warn";
  message: string;
  path?: string;
  line?: number;
}

export interface CompiledRules {
  schemaVersion: typeof RULES_SCHEMA_VERSION;
  generatedAt: string;
  sourceHash: string;
  rules: Rule[];
  diagnostics: RuleDiagnostic[];
}

const SEVERITIES = new Set<RuleSeverity>(["critical", "high", "medium", "low"]);
const CHECKS = new Set<RuleCheck>(["auto", "agent", "report"]);
const FIXES = new Set<RuleFix>(["mechanical", "report"]);
const STATUSES = new Set<RuleStatus>(["draft", "verified", "deprecated"]);
const SEVERITY_ORDER: Record<RuleSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function compileRules(
  root: string,
  options: { now?: Date } = {},
): CompiledRules {
  const specRoot = path.join(root, LAYOUT.paths.spec);
  const files = findRuleFiles(specRoot).sort();
  const diagnostics: RuleDiagnostic[] = [];
  const rules: Rule[] = [];
  const seen = new Map<string, string>();
  const hash = createHash("sha256");

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file).split(path.sep).join("/");
    hash.update(`${relative}\n${content}\n`);
    rules.push(...parseRulesFile(relative, content, diagnostics, seen));
  }

  return {
    schemaVersion: RULES_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    sourceHash: hash.digest("hex"),
    rules,
    diagnostics,
  };
}

export function parseRulesFile(
  relativePath: string,
  content: string,
  diagnostics: RuleDiagnostic[] = [],
  seen = new Map<string, string>(),
): Rule[] {
  const start = content.indexOf(RULES_START);
  const end = content.indexOf(RULES_END);
  if (start === -1 || end === -1 || end < start) {
    if (start !== -1 || end !== -1) {
      diagnostics.push({
        code: "rules.markers_incomplete",
        severity: "warn",
        message: "rules block has only one marker",
        path: relativePath,
      });
    }
    return [];
  }
  const body = content.slice(start + RULES_START.length, end);
  const lines = body.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line));
  if (headerIndex === -1) return [];

  const headers = splitRow(lines[headerIndex] ?? "");
  const required = ["ID", "Rule", "Scope", "Severity", "Check", "Fix", "Status", "Rationale"];
  const missing = required.filter(
    (name) => !headers.some((header) => header.toLowerCase() === name.toLowerCase()),
  );
  if (missing.length > 0) {
    diagnostics.push({
      code: "rules.missing_columns",
      severity: "error",
      message: `rules table is missing column(s): ${missing.join(", ")}`,
      path: relativePath,
    });
    return [];
  }

  const rules: Rule[] = [];
  for (let index = headerIndex + 2; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.every((cell) => /^:?-+:?$/.test(cell) || cell === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      row[header.toLowerCase()] = cells[column] ?? "";
    });
    const id = row.id?.trim() ?? "";
    if (!id) {
      diagnostics.push({
        code: "rules.missing_id",
        severity: "error",
        message: "rule row has no ID",
        path: relativePath,
        line: index + 1,
      });
      continue;
    }
    const location = `${relativePath}:${index + 1}`;
    if (seen.has(id)) {
      diagnostics.push({
        code: "rules.duplicate_id",
        severity: "error",
        message: `rule ${id} is already defined at ${seen.get(id)}`,
        path: relativePath,
        line: index + 1,
      });
      continue;
    }
    seen.set(id, location);

    const severity = row.severity as RuleSeverity;
    const check = row.check as RuleCheck;
    const fix = row.fix as RuleFix;
    const status = row.status as RuleStatus;
    for (const [name, value, valid] of [
      ["severity", severity, SEVERITIES],
      ["check", check, CHECKS],
      ["fix", fix, FIXES],
      ["status", status, STATUSES],
    ] as const) {
      if (!valid.has(value as never)) {
        diagnostics.push({
          code: "rules.invalid_value",
          severity: "error",
          message: `rule ${id} has invalid ${name}: ${String(value)}`,
          path: relativePath,
          line: index + 1,
        });
      }
    }
    const scope = String(row.scope ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/`/g, ""))
      .filter(Boolean);
    if (scope.length === 0) {
      diagnostics.push({
        code: "rules.empty_scope",
        severity: "error",
        message: `rule ${id} has no scope glob`,
        path: relativePath,
        line: index + 1,
      });
    }
    rules.push({
      id,
      statement: String(row.rule ?? "").trim(),
      scope,
      severity,
      check,
      fix,
      status,
      rationale: String(row.rationale ?? "").trim(),
      source: { path: relativePath, line: index + 1 },
    });
  }
  return rules;
}

/** Compile and write `.phronia/.runtime/rules.json`; returns the source hash. */
export function writeCompiledRules(root: string): CompiledRules {
  const compiled = compileRules(root);
  const target = path.join(root, LAYOUT.paths.rulesCompiled);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      `${JSON.stringify(
        { ...compiled, diagnostics: compiled.diagnostics },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.renameSync(temp, target);
  } catch {
    // Compilation is an enhancement; never fail the caller over a cache write.
  }
  return compiled;
}

export function readCompiledRules(root: string): CompiledRules | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, LAYOUT.paths.rulesCompiled), "utf8"),
    ) as CompiledRules;
    return parsed.schemaVersion === RULES_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** Verified rules whose scope matches a repo-relative path, strongest first. */
export function rulesForPath(
  rules: readonly Rule[],
  repoRelativePath: string,
  options: { limit?: number } = {},
): Rule[] {
  const normalized = repoRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return rules
    .filter(
      (rule) =>
        rule.status === "verified" &&
        rule.scope.some((pattern) => globMatches(pattern, normalized)),
    )
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.id.localeCompare(b.id),
    )
    .slice(0, options.limit ?? 8);
}

export function globMatches(pattern: string, filePath: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const regex = new RegExp(
    `^${normalized
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "__GLOBSTAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/__GLOBSTAR__/g, ".*")}$`,
  );
  return regex.test(filePath);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function findRuleFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findRuleFiles(full));
    } else if (entry.name === "rules.md") {
      out.push(full);
    }
  }
  return out;
}
export * from "./verdict.js";
