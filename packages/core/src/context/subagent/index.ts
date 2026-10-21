/**
 * Sub-agent spawn context.
 *
 * Resolves the active task, materializes JSONL-selected context plus task
 * artifacts, and returns a prompt mutation. Harness prompt mutation shape is
 * left to the shim via `mutations`.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { openState } from "../../state/index.js";
import { diagnostic, type Diagnostic } from "../../state/diagnostics.js";
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
} from "./materialize.js";
import {
  HOOK_MARKER,
  buildCheckPrompt,
  buildFinishPrompt,
  buildImplementPrompt,
  buildResearchPrompt,
} from "./prompts.js";

export type AgentType = "implement" | "check" | "research";

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

  const active = state.sessions.active(request.input, {
    platform: request.platform.id,
  });
  if ((agentType === "implement" || agentType === "check") && !active.taskPath) {
    return emptyResponse(request, root, "none", [
      diagnostic(
        "context.subagent.no_task",
        "info",
        "no active task; implement/check fall back to their pull-based preload",
      ),
    ]);
  }

  const limits = state.config().contextInjection;
  const diagnostics: Diagnostic[] = [];
  const taskRef = active.taskPath ? toRepoRelative(root, active.taskPath) : "";
  const finish = agentType !== "research" && originalPrompt.toLowerCase().includes("[finish]");

  let context: string;
  if (agentType === "research") {
    context = getResearchContext(root, LAYOUT);
  } else if (finish) {
    context = getFinishContext(root, taskRef, limits, diagnostics);
  } else if (agentType === "implement") {
    context = getImplementContext(root, taskRef, limits, diagnostics);
  } else {
    context = getCheckContext(root, taskRef, limits, diagnostics);
  }

  let prompt: string;
  if (agentType === "research") {
    prompt = buildResearchPrompt(originalPrompt, context);
  } else if (finish) {
    prompt = buildFinishPrompt(originalPrompt, context);
  } else if (agentType === "implement") {
    prompt = buildImplementPrompt(originalPrompt, context);
  } else {
    prompt = buildCheckPrompt(originalPrompt, context);
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

function toRepoRelative(root: string, taskRef: string): string {
  if (!path.isAbsolute(taskRef)) {
    return taskRef.split(path.sep).join("/");
  }
  const relative = path.relative(root, taskRef);
  return relative.split(path.sep).join("/");
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
