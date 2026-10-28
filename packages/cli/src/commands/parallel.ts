/**
 * `phronia task parallel plan|status` and `phronia task workspace ...`.
 *
 * Commands only parse options, render output, and pick an exit code
 * (design.md §10, §18.3, §23.1). All decisions live in the services/core.
 */

import {
  parallelStatus,
  planTasks,
  type PlanFailure,
  type PlanServiceResult,
  type ParallelStatusResult,
  type StatusServiceResult,
} from "../services/parallel.js";
import {
  bindWorkspace,
  ensureWorkspace,
  prepareWorkspace,
  reclaimWorkspace,
  releaseWorkspace,
  type WorkspaceResult,
} from "../services/workspace.js";

export interface ParallelCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly explain?: boolean;
  readonly includePlanning?: boolean;
  readonly max?: number;
  readonly allowUnknown?: boolean;
  readonly refs?: readonly string[];
  /** Optional harness id for the coordinator capability gate. */
  readonly platform?: string;
}

export interface WorkspaceCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly path?: string;
  readonly force?: boolean;
  readonly reuseDirty?: boolean;
  readonly copyTask?: boolean;
  readonly copy?: readonly string[];
  readonly postCreate?: readonly string[];
  readonly sessionKey?: string;
}

export interface PrepareCommandOptions extends WorkspaceCommandOptions {
  readonly forNewTask?: string;
}

export interface ReclaimCommandOptions extends WorkspaceCommandOptions {
  readonly ttlSeconds?: number;
}

export interface ReleaseCommandOptions extends WorkspaceCommandOptions {
  readonly sessionKey?: string;
}

export function runParallelPlan(options: ParallelCommandOptions): number {
  const result = planTasks({
    cwd: options.cwd,
    ...(options.includePlanning === true ? { includePlanning: true } : {}),
    ...(options.max === undefined ? {} : { maxConcurrent: options.max }),
    ...(options.allowUnknown === true ? { allowUnknown: true } : {}),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(toPlanJson(result), null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else {
    printPlan(result, options.explain === true);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

export function runParallelStatus(options: ParallelCommandOptions): number {
  const result = parallelStatus({
    cwd: options.cwd,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(toStatusJson(result), null, 2)}\n`);
  } else if (!result.ok) {
    printFailure(result);
  } else {
    printStatus(result);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

export function runWorkspacePrepare(options: PrepareCommandOptions): number {
  const result = prepareWorkspace({
    cwd: options.cwd,
    ...(options.forNewTask === undefined ? {} : { forNewTask: options.forNewTask }),
    ...(options.force === true ? { force: true } : {}),
    ...(options.reuseDirty === true ? { reuseDirty: true } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  });
  return renderWorkspace(result, options.json === true, "prepare");
}

export function runWorkspaceEnsure(
  taskRef: string,
  options: WorkspaceCommandOptions,
): number {
  const result = ensureWorkspace({
    cwd: options.cwd,
    taskRef,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.force === true ? { force: true } : {}),
    ...(options.reuseDirty === true ? { reuseDirty: true } : {}),
    ...(options.copyTask === true ? { copyTask: true } : {}),
    ...(options.copy === undefined ? {} : { copy: options.copy }),
    ...(options.postCreate === undefined ? {} : { postCreate: options.postCreate }),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  });
  return renderWorkspace(result, options.json === true, "ensure");
}

export function runWorkspaceBind(
  taskRef: string,
  options: WorkspaceCommandOptions,
): number {
  const result = bindWorkspace({
    cwd: options.cwd,
    taskRef,
    ...(options.path === undefined ? {} : { path: options.path }),
  });
  return renderWorkspace(result, options.json === true, "bind");
}

export function runWorkspaceRelease(options: ReleaseCommandOptions): number {
  const result = releaseWorkspace({
    cwd: options.cwd,
    ...(options.force === true ? { force: true } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  });
  return renderWorkspace(result, options.json === true, "release");
}

export function runWorkspaceReclaim(options: ReclaimCommandOptions): number {
  const result = reclaimWorkspace({
    cwd: options.cwd,
    ...(options.force === true ? { force: true } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  });
  return renderWorkspace(result, options.json === true, "reclaim");
}

function renderWorkspace(
  result: WorkspaceResult,
  json: boolean,
  verb: string,
): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        result.ok
          ? {
              ok: true,
              decision: result.decision,
              workspace: result.workspace,
              claim: result.claim,
              lease: result.lease,
              warnings: result.warnings,
              ...(result.provisional === undefined
                ? {}
                : { provisional: result.provisional }),
            }
          : result,
        null,
        2,
      )}\n`,
    );
  } else if (!result.ok) {
    printFailure(result);
  } else {
    printWorkspace(result, verb);
  }
  return result.ok ? 0 : exitCodeFor(result.code);
}

function printPlan(result: Extract<PlanServiceResult, { ok: true }>, explain: boolean): void {
  if (result.tasks.length === 0) {
    process.stdout.write("No active tasks to plan.\n");
    process.stderr.write(
      "next: create or start a task (`phronia task create \"<title>\"`), or pass --include-planning\n",
    );
    return;
  }
  const byRef = new Map(result.tasks.map((task) => [task.ref, task]));
  process.stdout.write(
    `Parallel plan: ${result.waves.length} wave(s), ${result.tasks.length} task(s)\n`,
  );
  for (const wave of result.waves) {
    process.stdout.write(`\nWave ${wave.index + 1} (${wave.tasks.length} task(s))\n`);
    for (const ref of wave.tasks) {
      const task = byRef.get(ref);
      process.stdout.write(`  ${ref}${task === undefined ? "" : ` — ${task.title}`}\n`);
      if (explain) {
        process.stdout.write(`    reason: ${wave.reasons[ref] ?? "independent"}\n`);
        process.stdout.write(
          `    footprint: ${
            task === undefined ? "unknown" : formatFootprint(task.footprint)
          }\n`,
        );
      }
    }
  }
  const containers = result.tasks.filter((task) => task.container);
  if (explain) {
    for (const container of containers) {
      process.stdout.write(
        `\nContainer ${container.ref}${container.title === "" ? "" : ` — ${container.title}`}\n`,
      );
      process.stdout.write(
        `  container (children: ${container.childCount}): coordinator only; start a child to execute\n`,
      );
    }
  }
  printDiagnostics(result.diagnostics);
}

function printStatus(result: ParallelStatusResult): void {
  const control = result.tasks.filter((task) => task.scope === "control-plane");
  const local = result.tasks.filter((task) => task.scope === "branch-local");
  process.stdout.write(`Shared runtime: ${result.runtime.sharedRoot}\n`);
  if (result.runtime.fallback) {
    process.stdout.write(
      "warning: git-common-dir is unavailable; using the per-checkout fallback\n",
    );
  }
  const claim = result.runtime.claim;
  process.stdout.write(
    `Main claim: ${
      claim === null
        ? "free"
        : `${String(claim.taskRef ?? claim.ownerRef ?? "unknown")} (${String(
            claim.state ?? "unknown",
          )})`
    }\n`,
  );
  process.stdout.write(`Leases: ${result.runtime.leases.length}\n`);

  printStatusGroup("Control-plane tasks", control);
  printStatusGroup("Branch-local tasks", local);
  printDiagnostics(result.diagnostics);
}

function printStatusGroup(
  title: string,
  tasks: ParallelStatusResult["tasks"],
): void {
  if (tasks.length === 0) return;
  process.stdout.write(`\n${title}\n`);
  for (const task of tasks) {
    const queue =
      task.queuePosition === null ? "" : ` queue=${task.queuePosition}`;
    const owner = task.owner === null ? "" : ` owner=${task.owner}`;
    process.stdout.write(
      `  ${task.ref} [${task.status}] integration=${task.integration.outcome}${queue}${owner}\n`,
    );
    process.stdout.write(`    workspace: ${task.workspace ?? "none"}\n`);
    if (task.branch !== null) process.stdout.write(`    branch: ${task.branch}\n`);
  }
}

function printWorkspace(
  result: Extract<WorkspaceResult, { ok: true }>,
  verb: string,
): void {
  const decision = result.decision;
  if (decision.kind === "reuse-current") {
    process.stdout.write(`Workspace ${verb}: reuse the main checkout\n`);
    process.stdout.write(`  reason: ${decision.reason}\n`);
  } else if (decision.kind === "attach") {
    process.stdout.write(`Workspace ${verb}: attach ${decision.path} (${decision.branch})\n`);
    process.stdout.write(`  reason: ${decision.reason}\n`);
  } else if (decision.kind === "create") {
    process.stdout.write(`Workspace ${verb}: create ${decision.path} (${decision.branch})\n`);
    process.stdout.write(`  base: ${decision.base}\n`);
    process.stdout.write(`  reason: ${decision.reason}\n`);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  if (result.claim !== null) {
    process.stdout.write(
      `  claim: ${String(result.claim.taskRef ?? result.claim.ownerRef)} (${result.claim.state})\n`,
    );
  }
}

function printDiagnostics(
  diagnostics: readonly {
    severity: string;
    code: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
  }[],
): void {
  for (const diagnostic of diagnostics) {
    const stream = diagnostic.severity === "error" ? process.stderr : process.stdout;
    stream.write(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`);
    for (const step of diagnosticNext(diagnostic.details)) {
      stream.write(`  next: ${step}\n`);
    }
  }
}

function diagnosticNext(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const next = details?.next;
  if (typeof next === "string" && next !== "") return [next];
  if (Array.isArray(next)) {
    return next.filter((item): item is string => typeof item === "string" && item !== "");
  }
  return [];
}

function printFailure(failure: PlanFailure): void {
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.stderr.write(`next: ${failure.next}\n`);
}

function formatFootprint(footprint: { kind: string; raw: readonly string[] }): string {
  if (footprint.kind === "unknown" || footprint.raw.length === 0) {
    return "unknown_footprint";
  }
  return `${footprint.kind}: ${footprint.raw.join(", ")}`;
}

function toPlanJson(result: PlanServiceResult): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    waves: result.waves,
    diagnostics: result.diagnostics,
    tasks: result.tasks.map((task) => ({
      ref: task.ref,
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      footprint: task.footprint,
      dependsOn: task.dependsOn,
      exclusive: task.exclusive,
      workspace: task.workspace,
      container: task.container,
      childCount: task.childCount,
    })),
  };
}

function toStatusJson(result: StatusServiceResult): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    tasks: result.tasks,
    runtime: result.runtime,
    capabilities: result.capabilities,
    diagnostics: result.diagnostics,
  };
}

export function exitCodeFor(code: string): number {
  switch (code) {
    case "WORKSPACE_CLAIM_BUSY":
    case "WORKSPACE_CLAIM_STALE_OWNED":
    case "WORKSPACE_CLAIM_STALE_DIRTY":
    case "LEASE_BUSY":
    case "INTEGRATE_LOCK_BUSY":
      return 3;
    case "INTEGRATE_VERIFY_FAILED":
    case "INTEGRATE_CONFLICT":
      return 1;
    default:
      return 2;
  }
}
