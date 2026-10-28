/**
 * SessionStart context assembly.
 *
 * This is the single implementation that replaces the Python hook, the
 * OpenCode JS copy, and the Pi/OMP/Snow variants. Blocks keep the original
 * order and wording; differences must be recorded in
 * docs/migrations/user-visible-changes.md.
 */

import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { openState } from "../state/index.js";
import type { ActiveTaskState } from "../state/session/active-task.js";
import type { TaskArtifacts } from "../state/tasks/artifacts.js";
import type { TaskRecordView } from "../state/tasks/record.js";
import type { Diagnostic } from "../state/diagnostics.js";
import { CORE_VERSION } from "../version.js";
import {
  CONTEXT_ORDER,
  READY,
  SESSION_CONTEXT,
  buildFirstReplyNotice,
} from "./constants.js";
import { buildRuntimeStateLines } from "./runtime-state.js";
import {
  CONTEXT_SCHEMA_VERSION,
  type ContextBlock,
  type Effect,
  type ContextRequest,
  type ContextResponse,
} from "./types.js";

export function buildSessionStart(request: ContextRequest): ContextResponse {
  const root = path.resolve(request.projectRoot);
  const state = openState({
    root,
    env: request.env,
    ...(request.options?.now === undefined ? {} : { now: () => request.options?.now ?? 0 }),
  });

  const active = state.sessions.active(request.input, {
    platform: request.platform.id,
  });
  const task = active.taskPath ? state.tasks.read(active.taskPath) : null;
  const artifacts = active.taskPath
    ? state.tasks.artifacts(active.taskPath)
    : emptyArtifacts();

  const specIndexPaths = state.spec.indexPaths(task?.package ?? null);
  const legacyWarning = state.spec.legacyWarning();
  const runtimeState = buildRuntimeStateLines({
    state,
    active,
    task,
    includeNext: false,
    ...(request.options?.now === undefined ? {} : { now: request.options.now }),
  });
  const blocks: ContextBlock[] = [];

  blocks.push({ id: "session-context", text: SESSION_CONTEXT, priority: 0 });
  blocks.push({
    id: "first-reply-notice",
    text: buildFirstReplyNotice(request.options?.updateHint ?? null),
    priority: 0,
    oncePerSession: true,
  });
  if (legacyWarning) {
    blocks.push({
      id: "migration-warning",
      text: `<migration-warning>\n${legacyWarning.message}\n</migration-warning>`,
      priority: 2,
    });
  }

  blocks.push({
    id: "current-state",
    text: `<current-state>\n${buildCurrentState(
      state,
      active,
      task,
      specIndexPaths.length,
      runtimeState.lines,
    )}\n</current-state>`,
    priority: 0,
  });
  blocks.push({
    id: "workflow-overview",
    text: `<phronia-workflow>\n${state.workflow.overview()}\n</phronia-workflow>`,
    priority: 1,
    source: { kind: "workflow", ref: LAYOUT.paths.workflow },
  });
  blocks.push({
    id: "guidelines",
    text: buildGuidelines(specIndexPaths),
    priority: 1,
  });
  blocks.push({
    id: "task-status",
    text: `<task-status>\n${buildTaskStatus(state, active, task, artifacts)}\n</task-status>`,
    priority: 0,
  });
  blocks.push({ id: "ready", text: READY, priority: 0 });

  const disabled = new Set(request.options?.disableBlocks ?? []);
  const enabledBlocks = blocks.filter((block) => !disabled.has(block.id));
  const diagnostics = [...state.diagnostics(), ...runtimeState.diagnostics];
  const env = request.env ?? process.env;
  const effects: Effect[] = [];
  if (env.CLAUDE_ENV_FILE && active.contextKey) {
    effects.push({
      type: "env-export",
      file: env.CLAUDE_ENV_FILE,
      line: `export PHRONIA_CONTEXT_ID=${shellQuote(active.contextKey)}`,
    });
  }

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "session-start",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: active.contextKey,
      keySource: active.sourceType === "none" ? "none" : active.sourceType,
      task: active.taskPath,
      taskSource: active.sourceType,
      taskStale: active.stale,
    },
    blocks: enabledBlocks,
    mutations: [],
    effects,
    envelope: envelopeFor(request.platform.id),
    degraded: !state.exists() || diagnostics.some((item) => item.severity === "error"),
    diagnostics: [...diagnostics],
  };
}

function buildCurrentState(
  state: ReturnType<typeof openState>,
  active: ActiveTaskState,
  task: TaskRecordView | null,
  specIndexCount: number,
  runtimeLines: readonly string[],
): string {
  const developer = state.developer().name;
  const git = state.git();
  const lines: string[] = [];
  lines.push(`Developer: ${developer ?? "(not initialized)"}`);
  const branch = git.branch || "(detached)";
  const dirty =
    git.dirtyPaths === null || git.dirtyPaths === 0
      ? "clean"
      : `dirty ${git.dirtyPaths} paths`;
  lines.push(`Git: branch ${branch}; ${dirty}.`);

  if (active.taskPath) {
    const status = task?.status ?? "unknown";
    lines.push(`Current task: ${active.taskPath}; status=${status}.`);
  } else {
    lines.push("Current task: none.");
  }

  lines.push(...runtimeLines);

  lines.push(
    `Active tasks: ${state.tasks.list().length} total. Use \`python3 ./${LAYOUT.paths.scripts}/task.py list --mine\` only if needed.`,
  );

  const journal = state.journal();
  if (journal.file) {
    lines.push(
      `Journal: ${journal.file}, ${journal.lineCount} / ${state.config().maxJournalLines} lines.`,
    );
  }
  if (specIndexCount > 0) {
    lines.push(`Spec indexes: ${specIndexCount} available.`);
  }
  return lines.join("\n");
}

function buildGuidelines(specIndexPaths: readonly string[]): string {
  const lines = ["<guidelines>", CONTEXT_ORDER, ""];
  if (specIndexPaths.length > 0) {
    lines.push("## Available indexes (read on demand)");
    for (const specPath of specIndexPaths) {
      lines.push(`- ${specPath}`);
    }
    lines.push("");
  }
  lines.push(
    `Discover more via: \`python3 ./${LAYOUT.paths.scripts}/get_context.py --mode packages\``,
  );
  lines.push("</guidelines>");
  return lines.join("\n");
}

function buildTaskStatus(
  state: ReturnType<typeof openState>,
  active: ActiveTaskState,
  task: TaskRecordView | null,
  artifacts: TaskArtifacts,
): string {
  if (!active.taskPath) {
    return [
      "Status: NO ACTIVE TASK",
      "Next-Action: Classify the current turn before creating any Phronia task. Simple conversation / small task asks only whether this turn should create a Phronia task. Complex task asks whether task creation and planning are allowed.",
    ].join("\n");
  }

  if (active.stale || !task) {
    return [
      "Status: STALE POINTER",
      `Task: ${active.taskPath}`,
      `Next-Action: Run \`python3 ./${LAYOUT.paths.scripts}/task.py finish\` to clear the stale pointer, then ask the user what to work on next.`,
    ].join("\n");
  }

  const present = presentArtifacts(artifacts);
  if (task.status === "completed") {
    return [
      "Status: COMPLETED",
      `Task: ${task.title}`,
      `Present: ${present}`,
      "Next-Action: Run `/phronia:finish-work`. If the working tree is dirty, return to Phase 3.4 first.",
    ].join("\n");
  }

  const implementCurated = state.tasks.curatedCount(task.ref, "implement");
  const checkCurated = state.tasks.curatedCount(task.ref, "check");
  const jsonlReady =
    (!artifacts.implementJsonl || implementCurated > 0) &&
    (!artifacts.checkJsonl || checkCurated > 0);

  if (task.status === "planning" && !artifacts.prd) {
    return [
      "Status: PLANNING",
      `Task: ${task.title}`,
      `Present: ${present}`,
      "Next-Action: Load `phronia-brainstorm` and write `prd.md`. Stay in planning.",
    ].join("\n");
  }

  if (task.status === "planning") {
    const missing = [
      ...(artifacts.design ? [] : ["design.md"]),
      ...(artifacts.implement ? [] : ["implement.md"]),
    ];
    const nextBits: string[] = [];
    if (missing.length > 0) {
      nextBits.push(
        `Lightweight task can request start review with PRD-only; complex task must add ${missing.join(", ")} before start`,
      );
    } else {
      nextBits.push("Planning artifacts are present; ask for review before `task.py start`");
    }
    if (!jsonlReady) {
      nextBits.push("curate `implement.jsonl` and `check.jsonl` before sub-agent mode start");
    }
    return [
      "Status: PLANNING",
      `Task: ${task.title}`,
      `Present: ${present}`,
      `Next-Action: ${nextBits.join("; ")}. Do not enter implementation until the user confirms start.`,
    ].join("\n");
  }

  return [
    `Status: ${(task.status ?? "UNKNOWN").toUpperCase()}`,
    `Task: ${task.title}`,
    `Present: ${present}`,
    "Next-Action: Follow the matching per-turn workflow-state. Implementation/check context order is jsonl entries -> `prd.md` -> `design.md if present` -> `implement.md if present`.",
  ].join("\n");
}

function presentArtifacts(artifacts: TaskArtifacts): string {
  const present: string[] = [];
  if (artifacts.prd) present.push("prd.md");
  if (artifacts.design) present.push("design.md");
  if (artifacts.implement) present.push("implement.md");
  if (artifacts.implementJsonl) present.push("implement.jsonl");
  if (artifacts.checkJsonl) present.push("check.jsonl");
  if (artifacts.research) present.push("research/");
  return present.length > 0 ? present.join(", ") : "(none)";
}

function emptyArtifacts(): TaskArtifacts {
  return {
    prd: false,
    design: false,
    implement: false,
    implementJsonl: false,
    checkJsonl: false,
    research: false,
    sizes: {},
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envelopeFor(platform: ContextRequest["platform"]["id"]): string {
  if (platform === "kiro") {
    return "kiro-plain";
  }
  if (platform === "zcode") {
    return "zcode-hook-v1";
  }
  return "claude-hook-v2";
}

/** Diagnostics helper for callers that need the raw list. */
export type SessionStartDiagnostics = Diagnostic[];
