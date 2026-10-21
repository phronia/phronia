/**
 * `phronia rules` — compile and inspect the specification rule ledger.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildVerdictFile,
  compileRules,
  writeCompiledRules,
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
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ path: target, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `verdict ${result.file.overall}: ${result.file.verdicts.length} evaluated, ${result.file.missing.length} missing -> ${target}\n`,
    );
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`warning: ${diagnostic}\n`);
    }
  }
  if (options.check) {
    if (result.diagnostics.length > 0) return 1;
    if (result.file.overall === "fail") return 1;
  }
  return 0;
}
