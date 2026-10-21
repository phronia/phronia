/**
 * Per-turn workflow breadcrumb.
 *
 * Replaces `inject-workflow-state.py`. A task-record error is distinct from
 * "no task": a session pointer can outlive a missing/corrupt task.json and
 * must say so instead of pretending the session has no work.
 */

import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { openState } from "../state/index.js";
import type { ActiveTaskState } from "../state/session/active-task.js";
import { buildBreadcrumb } from "../state/workflow/breadcrumb.js";
import { CORE_VERSION } from "../version.js";
import {
  CONTEXT_SCHEMA_VERSION,
  type ContextBlock,
  type ContextRequest,
  type ContextResponse,
} from "./types.js";

const CODEX_NO_TASK_BOOTSTRAP_NOTICE = `<phronia-bootstrap>
If you have not already loaded Phronia context this session, read the \`phronia-start\` skill once.
</phronia-bootstrap>`;

export function buildUserPrompt(request: ContextRequest): ContextResponse {
  const root = path.resolve(request.projectRoot);
  const state = openState({ root, env: request.env });
  const prompt = readPrompt(request);
  const config = state.config();

  if (state.workflow.shouldSkipPrompt(prompt)) {
    return baseResponse(request, root, state.sessions.active(request.input, {
      platform: request.platform.id,
    }), [], "none", [
      {
        code: "context.user_prompt.skipped",
        severity: "info",
        message: "skip keyword matched; no per-turn breadcrumb emitted",
      },
    ]);
  }

  const active = state.sessions.active(request.input, {
    platform: request.platform.id,
  });
  const task = active.taskPath ? state.tasks.read(active.taskPath) : null;

  let taskId: string | null = null;
  let status = "no_task";
  if (active.taskPath) {
    taskId = path.basename(active.taskPath);
    if (active.stale) {
      status = `stale_${active.sourceType}`;
    } else if (!task?.status) {
      status = "task_error";
    } else {
      taskId = task.id || taskId;
      status = task.status;
    }
  }

  const breadcrumbKey = state.workflow.breadcrumbKey(status);
  const breadcrumbs = state.workflow.breadcrumbs();
  const body =
    breadcrumbs[breadcrumbKey] ??
    breadcrumbs[status] ??
    "Refer to workflow.md for current step.";
  let text = buildBreadcrumb({
    status,
    taskId: active.taskPath ? taskId : null,
    body,
  });

  if (request.platform.id === "codex") {
    const parts: string[] = [];
    if (!active.taskPath) {
      parts.push(CODEX_NO_TASK_BOOTSTRAP_NOTICE);
    }
    parts.push(codexModeBanner(config.codexDispatchMode));
    parts.push(text);
    text = parts.join("\n\n");
  }

  const blocks: ContextBlock[] = [
    {
      id: "workflow-state",
      text,
      priority: 0,
      source: { kind: "workflow", ref: LAYOUT.paths.workflow },
    },
  ];

  return baseResponse(
    request,
    root,
    active,
    blocks,
    envelopeFor(request),
    [],
  );
}

function baseResponse(
  request: ContextRequest,
  root: string,
  active: ActiveTaskState,
  blocks: ContextBlock[],
  envelope: string,
  diagnostics: ContextResponse["diagnostics"],
): ContextResponse {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "user-prompt",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: active.contextKey,
      keySource: active.sourceType,
      task: active.taskPath,
      taskSource: active.sourceType,
      taskStale: active.stale,
    },
    blocks,
    mutations: [],
    effects: [],
    envelope,
    degraded: false,
    diagnostics,
  };
}

function readPrompt(request: ContextRequest): string {
  if (typeof request.hints?.prompt === "string") {
    return request.hints.prompt;
  }
  const input = request.input;
  if (typeof input === "object" && input !== null) {
    const prompt = (input as Record<string, unknown>).prompt;
    if (typeof prompt === "string") {
      return prompt;
    }
  }
  return "";
}

function codexModeBanner(mode: "auto" | "inline"): string {
  const meaning =
    mode === "auto"
      ? "auto: implement/check work defaults to Phronia sub-agents; native Codex context injection is preferred and child-side loading is the fallback. The main session still coordinates, clarifies, updates specs, commits, and finishes."
      : "inline: the main session implements/checks directly; do not dispatch implement/check sub-agents.";
  return `<codex-mode>${meaning}</codex-mode>`;
}

function envelopeFor(request: ContextRequest): string {
  if (request.platform.id === "kiro") {
    return "kiro-plain";
  }
  if (request.platform.id === "gemini") {
    return "gemini-before-agent";
  }
  return "claude-hook-v2";
}
