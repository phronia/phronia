/**
 * Machine-readable check verdicts.
 *
 * The check agent writes one entry per rule it evaluated. A missing verdict is
 * visible (`missing`), not treated as a pass. The file lands inside the task
 * directory so `task archive` moves it with the rest of the task.
 */

import fs from "node:fs";
import path from "node:path";
import type { Rule, RuleSeverity } from "./index.js";

export const VERDICT_SCHEMA_VERSION = 1 as const;

export type VerdictStatus = "pass" | "fail" | "skipped";

export interface RuleVerdict {
  id: string;
  status: VerdictStatus;
  evidence?: string;
  severity?: RuleSeverity;
}

export interface CheckVerdictFile {
  schemaVersion: typeof VERDICT_SCHEMA_VERSION;
  task: string;
  generatedAt: string;
  overall: "pass" | "fail" | "partial";
  verdicts: RuleVerdict[];
  missing: string[];
}

export interface VerdictValidation {
  file: CheckVerdictFile;
  diagnostics: string[];
}

export function buildVerdictFile(
  taskRef: string,
  verdicts: readonly RuleVerdict[],
  rules: readonly Rule[],
  options: { now?: Date } = {},
): VerdictValidation {
  const diagnostics: string[] = [];
  const known = new Map(rules.map((rule) => [rule.id, rule]));
  const clean: RuleVerdict[] = [];
  for (const verdict of verdicts) {
    if (!known.has(verdict.id)) {
      diagnostics.push(`unknown rule id: ${verdict.id}`);
      continue;
    }
    if (!["pass", "fail", "skipped"].includes(verdict.status)) {
      diagnostics.push(`rule ${verdict.id} has invalid status: ${String(verdict.status)}`);
      continue;
    }
    clean.push(verdict);
  }
  const evaluated = new Set(clean.filter((verdict) => verdict.status !== "skipped").map((v) => v.id));
  const missing = rules
    .filter((rule) => rule.status === "verified" && !evaluated.has(rule.id))
    .map((rule) => rule.id);
  const failed = clean.some((verdict) => verdict.status === "fail");
  const overall = failed ? "fail" : missing.length > 0 ? "partial" : "pass";
  return {
    file: {
      schemaVersion: VERDICT_SCHEMA_VERSION,
      task: taskRef,
      generatedAt: (options.now ?? new Date()).toISOString(),
      overall,
      verdicts: clean,
      missing,
    },
    diagnostics,
  };
}

export function verdictPath(root: string, taskRef: string): string {
  return path.join(root, taskRef, "check-results.json");
}

export function writeVerdictFile(
  root: string,
  taskRef: string,
  file: CheckVerdictFile,
): string {
  const target = verdictPath(root, taskRef);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return target;
}

export function readVerdictFile(
  root: string,
  taskRef: string,
): CheckVerdictFile | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(verdictPath(root, taskRef), "utf8"),
    ) as CheckVerdictFile;
    return parsed.schemaVersion === VERDICT_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}
