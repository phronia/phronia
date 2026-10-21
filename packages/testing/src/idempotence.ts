/**
 * Dogfood idempotence guard.
 *
 * `trellis update --dry-run` classifies every managed file. A healthy
 * repository has no `new`, `template-updated`, or `modified` entries: the
 * committed dogfood state is exactly what the templates render. Today the
 * fork has known drift (workflow/spec files customized upstream), so the guard
 * compares the observed drift against a recorded baseline instead of demanding
 * zero. New drift fails; resolving known drift also fails until the baseline
 * is intentionally updated.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DryRunReport {
  newFiles: string[];
  templateUpdated: string[];
  modified: string[];
  deleted: string[];
  userData: string[];
  upgrade: string | null;
  exitCode: number;
  raw: string;
}

export interface DriftBaseline {
  version: 1;
  recordedAt: string;
  note: string;
  modified: string[];
  deleted: string[];
}

export interface DriftComparison {
  newDrift: string[];
  resolvedDrift: string[];
  stillDrifting: string[];
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function parseUpdateDryRun(output: string, exitCode = 0): DryRunReport {
  const report: DryRunReport = {
    newFiles: [],
    templateUpdated: [],
    modified: [],
    deleted: [],
    userData: [],
    upgrade: null,
    exitCode,
    raw: output,
  };

  let section: keyof Pick<
    DryRunReport,
    "newFiles" | "templateUpdated" | "modified" | "deleted" | "userData"
  > | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    const trimmed = line.trim();

    if (trimmed.startsWith("New files")) {
      section = "newFiles";
      continue;
    }
    if (trimmed.startsWith("Template updated")) {
      section = "templateUpdated";
      continue;
    }
    if (trimmed.startsWith("Unchanged files")) {
      section = null;
      continue;
    }
    if (trimmed.startsWith("Modified by you")) {
      section = "modified";
      continue;
    }
    if (trimmed.startsWith("Deleted by you")) {
      section = "deleted";
      continue;
    }
    if (trimmed.startsWith("User data")) {
      section = "userData";
      continue;
    }

    const upgrade = /This will (?:UPGRADE|DOWNGRADE|CHANGE):\s*(.+)$/.exec(trimmed);
    if (upgrade?.[1]) {
      report.upgrade = upgrade[1].trim();
      section = null;
      continue;
    }

    if (section === null) {
      continue;
    }

    const entry = /^[+?\u2191\u2715\u25cb]\s+(.+)$/.exec(trimmed);
    if (!entry?.[1]) {
      continue;
    }
    const value = entry[1].trim();
    if (value.startsWith("... and ")) {
      continue;
    }
    report[section].push(value.replace(/\/$/, ""));
  }

  return report;
}

export function runUpdateDryRun(repoRoot: string): DryRunReport {
  const cli = path.join(repoRoot, "packages", "cli", "bin", "trellis.js");
  const result = spawnSync(process.execPath, [cli, "update", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return parseUpdateDryRun(output, result.status ?? 1);
}

export async function loadBaseline(baselinePath: string): Promise<DriftBaseline> {
  return JSON.parse(await readFile(baselinePath, "utf8")) as DriftBaseline;
}

export function compareDrift(
  report: DryRunReport,
  baseline: DriftBaseline,
): DriftComparison {
  const observed = new Set(report.modified);
  const expected = new Set(baseline.modified);
  const observedDeleted = new Set(report.deleted);
  const expectedDeleted = new Set(baseline.deleted);

  const newDrift = [
    ...[...observed].filter((item) => !expected.has(item)),
    ...[...observedDeleted].filter((item) => !expectedDeleted.has(item)),
  ].sort();
  const resolvedDrift = [
    ...[...expected].filter((item) => !observed.has(item)),
    ...[...expectedDeleted].filter((item) => !observedDeleted.has(item)),
  ].sort();
  const stillDrifting = [...observed].filter((item) => expected.has(item)).sort();

  return { newDrift, resolvedDrift, stillDrifting };
}

/**
 * Structural regressions are separate from user drift: a new file or a
 * template auto-update means the committed dogfood tree is missing something
 * the templates produce.
 */
export function structuralDrift(report: DryRunReport): string[] {
  return [...report.newFiles, ...report.templateUpdated].sort();
}
