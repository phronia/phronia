/**
 * `phronia rules` — compile and inspect the specification rule ledger.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildVerdictFile,
  compileGate,
  compileRules,
  evaluateGate,
  readGate,
  readVerdictFile,
  writeCompiledRules,
  writeGate,
  writeVerdictFile,
  type CompiledRules,
  type Rule,
  type RuleVerdict,
} from "@phronia/core";

export interface RulesOptions {
  cwd: string;
  json?: boolean;
  check?: boolean;
  severity?: string;
  status?: string;
}

export function runRulesCompile(options: RulesOptions): number {
  const compiled = writeCompiledRules(options.cwd);
  writeGate(options.cwd, compiled.rules);
  const errors = compiled.diagnostics.filter((item) => item.severity === "error");
  if (options.json) {
    process.stdout.write(`${JSON.stringify(compiled, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Compiled ${compiled.rules.length} rule(s) from ${compiled.sourceHash.slice(0, 12)}.\n`,
    );
    for (const diagnostic of compiled.diagnostics) {
      process.stdout.write(
        `${diagnostic.severity}: ${diagnostic.path ?? ""}${diagnostic.line ? `:${diagnostic.line}` : ""} ${diagnostic.message}\n`,
      );
    }
  }
  if (options.check && errors.length > 0) return 1;
  return 0;
}

export function runRulesList(options: RulesOptions): number {
  const compiled = compileRules(options.cwd);
  const rules = filterRules(compiled, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ rules }, null, 2)}\n`);
    return 0;
  }
  for (const rule of rules) {
    process.stdout.write(
      `${rule.id.padEnd(18)} ${rule.severity.padEnd(8)} ${rule.status.padEnd(10)} ${rule.statement}\n`,
    );
    process.stdout.write(
      `  scope: ${rule.scope.join(", ")}  · ${rule.source.path}:${rule.source.line}\n`,
    );
  }
  process.stdout.write(`\n${rules.length} rule(s).\n`);
  const errors = compiled.diagnostics.filter((item) => item.severity === "error");
  for (const diagnostic of errors) {
    process.stderr.write(`error: ${diagnostic.message}\n`);
  }
  return options.check && errors.length > 0 ? 1 : 0;
}

function filterRules(compiled: CompiledRules, options: RulesOptions): Rule[] {
  return compiled.rules.filter(
    (rule) =>
      (!options.severity || rule.severity === options.severity) &&
      (!options.status || rule.status === options.status),
  );
}

export interface VerdictOptions extends RulesOptions {
  task: string;
  input?: string;
  check?: boolean;
}

export function runRulesVerdict(options: VerdictOptions): number {
  const taskRef = options.task.replace(/\\/g, "/").replace(/^(\.\/)?/, "");
  const absolute = path.join(options.cwd, taskRef);
  if (!fs.existsSync(path.join(absolute, "task.json"))) {
    process.stderr.write(`task not found: ${taskRef}\n`);
    return 2;
  }
  if (!options.input) {
    process.stderr.write("usage: phronia rules verdict --task <ref> --input <file|->\n");
    return 2;
  }
  const raw =
    options.input === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(options.input, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `invalid verdict JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const verdicts = Array.isArray(parsed)
    ? (parsed as RuleVerdict[])
    : (parsed as { verdicts?: RuleVerdict[] }).verdicts;
  if (!Array.isArray(verdicts)) {
    process.stderr.write("verdict input must be an array or { verdicts: [] }\n");
    return 2;
  }
  const compiled = compileRules(options.cwd);
  const result = buildVerdictFile(taskRef, verdicts, compiled.rules);
  const target = writeVerdictFile(options.cwd, taskRef, result.file);
  const gate = readGate(options.cwd) ?? compileGate(compiled.rules);
  const gateResult = evaluateGate({
    gate,
    rules: compiled.rules,
    verdict: result.file,
    enforced: true,
  });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          path: target,
          ...result,
          coverage: gateResult.coverage,
          gateAllowed: gateResult.allowed,
          gateViolations: gateResult.violations,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `verdict ${result.file.overall}: ${result.file.verdicts.length} evaluated, ` +
        `${result.file.missing.length} missing, coverage ${(gateResult.coverage * 100).toFixed(1)}% -> ${target}\n`,
    );
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`warning: ${diagnostic}\n`);
    }
  }
  if (options.check) {
    if (result.diagnostics.length > 0) return 1;
    if (!gateResult.allowed) return 1;
  }
  return 0;
}

export interface GateOptions extends RulesOptions {
  changed?: boolean;
  task?: string;
}

export function runRulesGate(options: GateOptions): number {
  const compiled = compileRules(options.cwd);
  const changedPaths = options.changed ? gitChangedPaths(options.cwd) : [];
  const verdict = options.task
    ? readVerdictFile(options.cwd, options.task)
    : null;
  const gate = readGate(options.cwd) ?? compileGate(compiled.rules);
  const result = evaluateGate({
    gate,
    rules: compiled.rules,
    changedPaths,
    verdict,
    enforced: true,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      result.allowed
        ? `gate pass: ${changedPaths.length} changed path(s), coverage ${(result.coverage * 100).toFixed(1)}%\n`
        : `gate blocked: ${result.violations.length} violation(s), coverage ${(result.coverage * 100).toFixed(1)}%\n`,
    );
    for (const violation of result.violations) {
      process.stdout.write(
        `  ${violation.severity.padEnd(8)} ${violation.code}: ${violation.message}\n`,
      );
    }
  }
  return result.allowed ? 0 : 1;
}

function gitChangedPaths(root: string): string[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
