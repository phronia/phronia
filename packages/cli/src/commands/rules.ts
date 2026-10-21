/**
 * `phronia rules` — compile and inspect the specification rule ledger.
 */

import {
  compileRules,
  writeCompiledRules,
  type CompiledRules,
  type Rule,
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
