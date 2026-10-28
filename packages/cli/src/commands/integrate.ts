/**
 * `phronia task integrate <ref>` command layer (design.md §10, §18.3).
 *
 * This file only parses options, renders results, and picks an exit code. The
 * serial landing/remote/recovery logic lives in `services/integrate.ts`.
 */

import fs from "node:fs";
import type {
  IntegrationMode,
  ResolvedMode,
} from "@phronia/core/task";
import {
  integrateTask,
  type DrainItemResult,
  type IntegrateFailure,
  type IntegrateResult,
  type IntegrateSuccess,
  type ModeChoiceContext,
} from "../services/integrate.js";

export interface IntegrateCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly mode?: IntegrationMode;
  readonly base?: string;
  readonly queue?: boolean;
  readonly wait?: boolean;
  readonly drain?: boolean;
  readonly verify?: readonly string[];
  readonly noVerify?: boolean;
  readonly timeout?: string;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly handoff?: boolean;
  readonly dryRun?: boolean;
  readonly recover?: boolean;
  readonly rollback?: boolean;
  readonly force?: boolean;
  readonly sync?: boolean;
  readonly sessionKey?: string;
  readonly ownerId?: string;
}

export function runTaskIntegrate(
  taskRef: string | null,
  options: IntegrateCommandOptions,
): number {
  const result = integrateTask({
    cwd: options.cwd,
    taskRef,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.queue === true ? { queue: true } : {}),
    ...(options.wait === true ? { wait: true } : {}),
    ...(options.drain === true ? { drain: true } : {}),
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    ...(options.noVerify === true ? { noVerify: true } : {}),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.interactive === true ? { interactive: true } : {}),
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.handoff === true ? { handoff: true } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    ...(options.recover === true ? { recover: true } : {}),
    ...(options.rollback === true ? { rollback: true } : {}),
    ...(options.force === true ? { force: true } : {}),
    ...(options.sync === true ? { sync: true } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    chooseMode: (context) => promptForMode(context, options),
    confirmRollback: () => promptForRollback(taskRef ?? "the integration branch"),
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodeFor(result);
  }
  render(result);
  return exitCodeFor(result);
}

function render(result: IntegrateResult): void {
  if (result.modeReason !== null) {
    process.stdout.write(`${result.modeReason}\n`);
  }
  if (result.ok) {
    renderSuccess(result);
    return;
  }
  renderFailure(result);
}

function renderSuccess(result: IntegrateSuccess): void {
  if (result.results !== undefined) {
    renderDrain(result.results);
    return;
  }
  if (result.dryRun === true) {
    process.stdout.write(
      `Dry run: ${result.taskRef ?? "task"} mode=${result.mode ?? "unknown"}\n`,
    );
    for (const warning of result.warnings ?? []) {
      process.stdout.write(`  ${warning}\n`);
    }
    return;
  }
  if (result.queued === true) {
    process.stdout.write(
      `Queued ${result.taskRef ?? "task"} at position ${String(
        result.queuePosition ?? 0,
      )}.\n`,
    );
    if (result.next !== null) process.stdout.write(`next: ${result.next}\n`);
    return;
  }

  if (result.outcome === "landed") {
    process.stdout.write(
      `Integrated ${result.taskRef ?? "task"}: ${result.baseSha ?? "?"} -> ${
        result.commit ?? "?"
      } (${result.branch ?? result.baseBranch ?? "base"})\n`,
    );
  } else if (result.outcome === "pushed") {
    process.stdout.write(
      `Pushed ${result.taskRef ?? "task"} on ${result.branch ?? "task branch"} (outcome=pushed)\n`,
    );
  } else if (result.outcome === "needs_human") {
    process.stdout.write(
      `${result.taskRef ?? "task"}: needs human decision (outcome=needs_human)\n`,
    );
  } else if (result.outcome === "blocked") {
    process.stdout.write(
      `${result.taskRef ?? "task"}: blocked (outcome=blocked)\n`,
    );
  } else {
    process.stdout.write(
      `${result.taskRef ?? "task"}: nothing to land (outcome=${result.outcome})\n`,
    );
  }

  if (result.prUrl !== null) {
    process.stdout.write(`PR/MR: ${result.prUrl}\n`);
  }
  if (result.compareUrl !== null && result.compareUrl !== undefined) {
    process.stdout.write(`Compare: ${result.compareUrl}\n`);
  }
  if (result.manualCommand !== null && result.manualCommand !== undefined) {
    process.stdout.write(`Manual: ${result.manualCommand}\n`);
  }
  if (result.sync !== null && result.sync !== undefined) {
    process.stdout.write(`Remote sync: ${result.sync}\n`);
  }
  if (result.logPath !== null) {
    process.stdout.write(`Log: ${result.logPath}\n`);
  }
  if (result.handoffPath !== null && result.handoffPath !== undefined) {
    process.stdout.write(`Handoff: ${result.handoffPath}\n`);
  }
  for (const warning of result.warnings ?? []) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  if (result.next !== null) process.stdout.write(`next: ${result.next}\n`);
}

function renderDrain(results: readonly DrainItemResult[]): void {
  const failed = results.filter((item) => !item.ok).length;
  process.stdout.write(
    `Queue drained: ${results.length - failed} landed, ${failed} blocked\n`,
  );
  for (const item of results) {
    process.stdout.write(
      `  ${item.taskRef}: ${item.ok ? item.outcome : `${item.code} (${item.outcome ?? "none"})`}\n`,
    );
  }
}

function renderFailure(result: IntegrateFailure): void {
  process.stderr.write(`${result.code}: ${result.message}\n`);
  process.stderr.write(`next: ${result.next}\n`);
  if (result.conflict !== undefined && result.conflict !== null) {
    process.stderr.write(
      `conflict: ${result.conflict.kind}${
        result.conflict.files.length === 0
          ? ""
          : ` (${result.conflict.files.join(", ")})`
      }\n`,
    );
  }
  if (result.logPath !== undefined && result.logPath !== null) {
    process.stderr.write(`log: ${result.logPath}\n`);
  }
  if (result.handoffPath !== undefined && result.handoffPath !== null) {
    process.stderr.write(`handoff: ${result.handoffPath}\n`);
  }
}

function exitCodeFor(result: IntegrateResult): number {
  if (result.ok) {
    if (result.results === undefined) return 0;
    return result.results.every((item) => item.ok) ? 0 : 1;
  }
  switch (result.code) {
    case "INTEGRATE_LOCK_BUSY":
    case "LEASE_BUSY":
    case "WORKSPACE_CLAIM_BUSY":
    case "WORKSPACE_CLAIM_STALE_OWNED":
    case "WORKSPACE_CLAIM_STALE_DIRTY":
    case "INTEGRATE_REMOTE_UNSUPPORTED":
      return 3;
    case "INTEGRATE_VERIFY_FAILED":
    case "INTEGRATE_CONFLICT":
    case "INTEGRATE_BASE_MOVED":
    case "INTEGRATE_RECOVER_NEEDS_HUMAN":
      return 1;
    default:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Synchronous prompts (no shell, no async in the command action)
// ---------------------------------------------------------------------------

function promptForMode(
  context: ModeChoiceContext,
  options: IntegrateCommandOptions,
): ResolvedMode | null {
  if (options.yes === true && options.interactive !== true) {
    return context.resolution.mode;
  }
  const alternatives = context.resolution.alternatives;
  process.stderr.write(`\nTask ${context.taskRef} is ready to integrate.\n`);
  process.stderr.write(`Base: ${context.baseBranch}\n`);
  process.stderr.write(`${context.resolution.reason}\n\n`);
  const choices: { readonly label: string; readonly mode: ResolvedMode }[] = [];
  if (alternatives.includes("remote")) {
    choices.push({
      label:
        "remote MR/PR — push the task branch, open a change request; Phronia will not merge",
      mode: "remote",
    });
  }
  if (alternatives.includes("local")) {
    choices.push({
      label:
        "local merge — rebase onto the base and fast-forward; linear history, no PR",
      mode: "local",
    });
  }
  for (const [index, choice] of choices.entries()) {
    process.stderr.write(`[${index + 1}] ${choice.label}\n`);
  }
  process.stderr.write(`[${choices.length + 1}] cancel\n`);
  process.stderr.write(`choice> `);
  const answer = readLine();
  if (answer === null || answer === "") return null;
  const normalized = answer.toLowerCase();
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1]?.mode ?? null;
  }
  for (const choice of choices) {
    if (normalized === choice.mode) return choice.mode;
  }
  return null;
}

function promptForRollback(taskRef: string): boolean {
  process.stderr.write(
    `Rollback moves the integration branch back with \`git reset --hard\` for ${taskRef}.\n`,
  );
  process.stderr.write(`Type "yes" to confirm> `);
  return (readLine() ?? "").toLowerCase() === "yes";
}

function readLine(): string | null {
  const buffer = Buffer.alloc(4096);
  try {
    const bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    if (bytes <= 0) return null;
    return buffer.toString("utf8", 0, bytes).trim();
  } catch {
    return null;
  }
}
