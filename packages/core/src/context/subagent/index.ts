/**
 * Sub-agent spawn context.
 *
 * Resolves the active task, materializes JSONL-selected context plus task
 * artifacts, and returns a prompt mutation. Harness prompt mutation shape is
 * left to the shim via `mutations`.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { capabilitiesFor } from "../../platform/capabilities.js";
import { openState } from "../../state/index.js";
import { diagnostic, type Diagnostic } from "../../state/diagnostics.js";
import { readRuntimeFacts } from "../../state/runtime-facts.js";
import type { ActiveTaskState } from "../../state/session/active-task.js";
import { normalizeTaskRef } from "../../state/tasks/refs.js";
import { evaluateDispatch } from "../../task/dispatch/policy.js";
import type { DispatchVerdict } from "../../task/dispatch/types.js";
import { CORE_VERSION } from "../../version.js";
import {
  CONTEXT_SCHEMA_VERSION,
  type ContextRequest,
  type ContextResponse,
} from "../types.js";
import {
  getCheckContext,
  getFinishContext,
  getImplementContext,
  getResearchContext,
  getSessionContext,
} from "./materialize.js";
import { agentMutationFor, buildDispatchFacts } from "./facts.js";
import { applyEnforcement, renderGuard } from "./guard.js";
import {
  HOOK_MARKER,
  buildCheckPrompt,
  buildFinishPrompt,
  buildImplementPrompt,
  buildResearchPrompt,
} from "./prompts.js";

export type AgentType = "implement" | "check" | "research" | "session";

const AGENT_TYPES: Record<string, AgentType> = {
  "phronia-implement": "implement",
  "phronia-check": "check",
  "phronia-research": "research",
  "trellis-implement": "implement",
  "trellis-check": "check",
  "trellis-research": "research",
  implement: "implement",
  check: "check",
  research: "research",
  session: "session",
  main: "session",
};

export function normalizeAgentType(value: string | null | undefined): AgentType | null {
  if (!value) {
    return null;
  }
  return AGENT_TYPES[value.trim().toLowerCase()] ?? null;
}

export function buildSubagentSpawn(request: ContextRequest): ContextResponse {
  const root = path.resolve(request.projectRoot);
  const agentType = readAgentType(request);
  const originalPrompt = readPrompt(request);
  const state = openState({ root, env: request.env });

  if (!agentType) {
    return emptyResponse(request, root, "none", [
      diagnostic(
        "context.subagent.unknown_agent",
        "info",
        "payload did not identify a Phronia sub-agent type",
      ),
    ]);
  }

  const allowSingleSessionFallback = readAllowSingleSessionFallback(request);
  const requestedRef = readTaskRef(request);
  // Resolve the session pointer and the decision target separately: the
  // effective task may be an explicit child, and the policy needs the session
  // pointer to detect cross-task dispatch.
  const sessionActive = state.sessions.active(request.input, {
    platform: request.platform.id,
    // Python's sub-agent hook opts in; native dispatchers that own an exact
    // session id can opt out to avoid borrowing a sibling window.
    allowSingleSessionFallback,
  });
  const active = state.sessions.active(request.input, {
    platform: request.platform.id,
    taskRef: requestedRef,
    allowSingleSessionFallback,
  });
  if (
    (agentType === "implement" || agentType === "check" || agentType === "session") &&
    !active.taskPath
  ) {
    return emptyResponse(request, root, "none", [
      diagnostic(
        "context.subagent.no_task",
        "info",
        "no active task; implement/check fall back to their pull-based preload",
      ),
    ]);
  }

  const contextOnly = readContextOnly(request);
  if (agentType === "session" && !contextOnly) {
    return emptyResponse(request, root, "none", [
      diagnostic(
        "context.subagent.session_requires_context_only",
        "warn",
        "the session scope materializes context only and has no prompt wrapper",
      ),
    ]);
  }

  const config = state.config();
  const limits = config.contextInjection;
  const diagnostics: Diagnostic[] = [];
  const dispatch = isDispatchRequest(request, agentType);
  let guardText = "";
  if (dispatch) {
    const runtime = readRuntimeFacts({ root, includeMainDirty: true });
    // Informational runtime notes (missing claim/registry) are normal; only
    // failures need to reach the response.
    diagnostics.push(
      ...runtime.diagnostics.filter((item) => item.severity !== "info"),
    );
    const capabilities = capabilitiesFor(
      request.platform.id,
      request.platform.adapterId,
    );
    const facts = buildDispatchFacts({
      state,
      root,
      runtime,
      sessionActive,
      effectiveActive: active,
      requestedRef,
      agent: agentMutationFor(agentType),
      platform: {
        id: request.platform.id,
        adapterId: request.platform.adapterId ?? null,
      },
      enforce: config.parallel.dispatch.enforce,
      sessionKey: sessionActive.contextKey ?? active.contextKey,
    });
    const verdict = evaluateDispatch(facts);
    const enforcement = applyEnforcement(verdict, {
      hookPolicy: capabilities.hookPolicy,
      enforce: config.parallel.dispatch.enforce,
      platformId: request.platform.id,
      subagentWorkspace: capabilities.subagentWorkspace,
    });
    diagnostics.push(dispatchDiagnostic(verdict));
    diagnostics.push(...enforcement.diagnostics);

    if (enforcement.deny !== undefined) {
      // A deny replaces the prompt entirely: no PRD/context is materialized,
      // because the reason itself is the instruction to the parent model.
      return {
        ...baseResponse(request, root, active, diagnostics),
        mutations: [enforcement.deny],
        envelope: "mutation-plan",
        degraded: false,
      };
    }
    if (enforcement.guard !== undefined) {
      guardText = renderGuard(enforcement.guard);
    }
  }

  const record = active.taskPath ? state.tasks.read(active.taskPath) : null;
  const taskRef = record
    ? record.ref
    : active.taskPath
      ? normalizeTaskRef(toRepoRelative(root, active.taskPath))
      : "";
  const finish = agentType !== "research" && originalPrompt.toLowerCase().includes("[finish]");

  let context: string;
  if (agentType === "research") {
    context = getResearchContext(root, LAYOUT);
  } else if (finish) {
    context = getFinishContext(root, taskRef, limits, diagnostics);
  } else if (agentType === "implement") {
    context = getImplementContext(root, taskRef, limits, diagnostics);
  } else if (agentType === "check") {
    context = getCheckContext(root, taskRef, limits, diagnostics);
  } else {
    context = getSessionContext(root, taskRef, limits, diagnostics);
  }

  let prompt = "";
  if (agentType === "research") {
    prompt = buildResearchPrompt(originalPrompt, context);
  } else if (finish) {
    prompt = buildFinishPrompt(originalPrompt, context);
  } else if (agentType === "implement") {
    prompt = buildImplementPrompt(originalPrompt, context);
  } else if (agentType === "check") {
    prompt = buildCheckPrompt(originalPrompt, context);
  }

  if (guardText !== "") {
    // The model is most sensitive to the start of the prompt; keep the guard
    // ahead of the hook marker and the materialized context.
    prompt = `${guardText}\n\n${prompt}`;
  }
  const injectedContext =
    guardText === "" ? context : `${guardText}\n\n${context}`;

  if (dispatch && request.platform.id === "codex") {
    // Codex `SubagentStart` runs after the child exists and can only add
    // context. Returning a PreToolUse-shaped mutation here is the historical
    // gap: Codex cannot consume it, so the context was silently lost.
    return {
      ...baseResponse(request, root, active, diagnostics),
      blocks: injectedContext
        ? [{ id: "subagent-context", text: injectedContext, priority: 0 }]
        : [],
      envelope: "codex-subagent-start",
    };
  }

  if (contextOnly) {
    // Harnesses that inject materialized context ahead of a turn (OMP session
    // start, Snow's sub-agent hook) need the source material without the
    // agent-role prompt wrapper.
    return {
      ...baseResponse(request, root, active, diagnostics),
      blocks: injectedContext
        ? [{ id: "subagent-context", text: injectedContext, priority: 0 }]
        : [],
      envelope: "plain",
    };
  }

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "subagent-spawn",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: active.contextKey,
      keySource: active.sourceType,
      task: active.taskPath,
      taskSource: active.sourceType,
      taskStale: active.stale,
    },
    blocks: [],
    mutations: [{ op: "set-prompt", value: prompt, marker: HOOK_MARKER }],
    effects: [],
    envelope: "mutation-plan",
    degraded: diagnostics.some((item) => item.severity === "error"),
    diagnostics,
  };
}

export function readAgentType(request: ContextRequest): AgentType | null {
  const hint = normalizeAgentType(request.hints?.agentType);
  if (hint) return hint;
  const input = objectInput(request.input);
  if (!input) return null;
  for (const key of [
    "subagent_type",
    "subagentType",
    "subagent_type_name",
    "subagentTypeName",
    "subagent_name",
    "subagentName",
    "agent_type",
    "agentType",
    "agent_name",
    "name",
  ]) {
    const value = stringField(input[key]);
    const type = normalizeAgentType(value);
    if (type) return type;
  }
  const toolInput = objectInput(input.tool_input) ?? objectInput(input.toolInput);
  if (toolInput) {
    for (const key of ["subagent_type", "subagentType", "agent_type", "name"]) {
      const type = normalizeAgentType(stringField(toolInput[key]));
      if (type) return type;
    }
  }
  return null;
}

function readAllowSingleSessionFallback(request: ContextRequest): boolean {
  if (request.hints?.allowSingleSessionFallback !== undefined) {
    return request.hints.allowSingleSessionFallback;
  }
  const input = objectInput(request.input);
  if (input) {
    if (typeof input.allow_single_session_fallback === "boolean") {
      return input.allow_single_session_fallback;
    }
    if (typeof input.allowSingleSessionFallback === "boolean") {
      return input.allowSingleSessionFallback;
    }
  }
  return true;
}

function readTaskRef(request: ContextRequest): string | null {
  if (typeof request.hints?.taskRef === "string" && request.hints.taskRef.trim()) {
    return request.hints.taskRef.trim();
  }
  const input = objectInput(request.input);
  if (input) {
    for (const key of ["task_ref", "taskRef", "active_task", "activeTask"]) {
      const value = stringField(input[key]);
      if (value) return value;
    }
    const toolInput = objectInput(input.tool_input) ?? objectInput(input.toolInput);
    if (toolInput) {
      for (const key of ["task_ref", "taskRef"]) {
        const value = stringField(toolInput[key]);
        if (value) return value;
      }
    }
  }
  // None of the three mainstream Agent tools exposes a task_ref field (W0), so
  // the dispatch prompt is the only portable channel. Only the first non-empty
  // line is considered: a stray "Active task:" mid-paragraph must not win.
  return readTaskRefFromPrompt(readPrompt(request));
}

const ACTIVE_TASK_LINE = /^\s*Active task:\s*(.+?)\s*$/i;

function readTaskRefFromPrompt(prompt: string): string | null {
  if (prompt.trim() === "") return null;
  for (const line of prompt.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = ACTIVE_TASK_LINE.exec(line);
    if (match === null) return null;
    const value = match[1]?.trim() ?? "";
    return value === "" ? null : value;
  }
  return null;
}

function readContextOnly(request: ContextRequest): boolean {
  if (request.hints?.contextOnly === true) {
    return true;
  }
  const input = objectInput(request.input);
  if (!input) return false;
  return input.context_only === true || input.contextOnly === true;
}

function readPrompt(request: ContextRequest): string {
  if (typeof request.hints?.prompt === "string") {
    return request.hints.prompt;
  }
  const input = objectInput(request.input);
  if (!input) return "";
  const toolInput = objectInput(input.tool_input) ?? objectInput(input.toolInput);
  const fromTool = toolInput ? stringField(toolInput.prompt) : null;
  return fromTool ?? stringField(input.prompt) ?? "";
}

function emptyResponse(
  request: ContextRequest,
  root: string,
  envelope: string,
  diagnostics: Diagnostic[],
): ContextResponse {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "subagent-spawn",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: null,
      keySource: "none",
      task: null,
      taskSource: "none",
      taskStale: false,
    },
    blocks: [],
    mutations: [],
    effects: [],
    envelope,
    degraded: false,
    diagnostics,
  };
}

function baseResponse(
  request: ContextRequest,
  root: string,
  active: ActiveTaskState,
  diagnostics: Diagnostic[],
): ContextResponse {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "subagent-spawn",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: active.contextKey,
      keySource: active.sourceType,
      task: active.taskPath,
      taskSource: active.sourceType,
      taskStale: active.stale,
    },
    blocks: [],
    mutations: [],
    effects: [],
    envelope: "plain",
    degraded: diagnostics.some((item) => item.severity === "error"),
    diagnostics,
  };
}

function toRepoRelative(root: string, taskRef: string): string {
  if (!path.isAbsolute(taskRef)) {
    return taskRef.split(path.sep).join("/");
  }
  const relative = path.relative(root, taskRef);
  return relative.split(path.sep).join("/");
}

/**
 * Admission applies only to a real sub-agent dispatch (design.md §7.2.1).
 * `pre-tool-use` also reaches `buildSubagentSpawn` when the host exposes no
 * tool name; in that case a recognizable agent type in the payload is the
 * dispatch signal.
 */
function isDispatchRequest(
  request: ContextRequest,
  agentType: AgentType | null,
): boolean {
  if (request.event === "subagent-spawn") {
    return true;
  }
  if (request.event !== "pre-tool-use") {
    return false;
  }
  const toolName = readToolName(request);
  if (toolName !== null) {
    const { toolNames } = capabilitiesFor(
      request.platform.id,
      request.platform.adapterId,
    );
    if (toolNames.subagent.includes(toolName)) {
      return true;
    }
  }
  return payloadCarriesAgentType(request, agentType);
}

const AGENT_TYPE_FIELDS = [
  "subagent_type",
  "subagentType",
  "subagent_type_name",
  "subagentTypeName",
  "subagent_name",
  "subagentName",
  "agent_type",
  "agentType",
  "agent_name",
  "name",
] as const;

const TOOL_INPUT_AGENT_TYPE_FIELDS = [
  "subagent_type",
  "subagentType",
  "agent_type",
  "name",
] as const;

function payloadCarriesAgentType(
  request: ContextRequest,
  agentType: AgentType | null,
): boolean {
  if (agentType === null) {
    return false;
  }
  if (typeof request.hints?.agentType === "string") {
    return true;
  }
  const input = objectInput(request.input);
  if (!input) {
    return false;
  }
  if (hasAgentTypeField(input, AGENT_TYPE_FIELDS)) {
    return true;
  }
  const toolInput =
    objectInput(input.tool_input) ?? objectInput(input.toolInput);
  return (
    toolInput !== null &&
    hasAgentTypeField(toolInput, TOOL_INPUT_AGENT_TYPE_FIELDS)
  );
}

function hasAgentTypeField(
  input: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some(
    (key) => normalizeAgentType(stringField(input[key])) !== null,
  );
}

function readToolName(request: ContextRequest): string | null {
  if (typeof request.hints?.toolName === "string" && request.hints.toolName.trim()) {
    return request.hints.toolName.trim().toLowerCase();
  }
  const input = objectInput(request.input);
  if (!input) {
    return null;
  }
  const value = input.tool_name ?? input.toolName;
  return typeof value === "string" ? value.toLowerCase() : null;
}

function dispatchDiagnostic(verdict: DispatchVerdict): Diagnostic {
  return diagnostic(
    `context.subagent.${verdict.code.toLowerCase()}`,
    verdict.severity,
    `${verdict.code}: ${verdict.reason}`,
    { details: verdict.details },
  );
}

function objectInput(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
