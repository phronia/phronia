/**
 * `phronia context` entrypoint.
 *
 * One implementation for every harness. Core returns a neutral plan; the shim
 * renders the envelope. Events other than session-start land in later batches
 * and return an explicit `not-implemented` diagnostic, never a silent empty
 * success without a trace.
 */

import type { ContextEvent, ContextRequest, ContextResponse } from "./types.js";
import { CONTEXT_SCHEMA_VERSION } from "./types.js";
import { buildSessionStart } from "./session-start.js";
import { buildUserPrompt } from "./user-prompt.js";
import { buildPreShell } from "./pre-shell.js";
import { buildPreEdit } from "./pre-edit.js";
import { buildSubagentSpawn } from "./subagent/index.js";
import { capabilitiesFor } from "../platform/capabilities.js";
import { CORE_VERSION } from "../version.js";
import { diagnostic, type Diagnostic } from "../state/diagnostics.js";

export * from "./types.js";
export * from "./constants.js";
export * from "./session-start.js";
export * from "./user-prompt.js";
export * from "./pre-shell.js";
export * from "./pre-edit.js";
export * from "./subagent/index.js";
export * from "./subagent/materialize.js";
export * from "./subagent/prompts.js";
export { contextJsonSchema } from "./contract.js";

export class ContextContractError extends Error {}

export function handleContext(request: ContextRequest): ContextResponse {
  if (request.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
    throw new ContextContractError(
      `unsupported context schemaVersion ${String(request.schemaVersion)}; expected ${CONTEXT_SCHEMA_VERSION}`,
    );
  }
  if (!request.projectRoot) {
    throw new ContextContractError("projectRoot is required");
  }
  switch (request.event) {
    case "session-start":
      return buildSessionStart(request);
    case "user-prompt":
      return buildUserPrompt(request);
    case "pre-shell":
      return buildPreShell(request);
    case "subagent-spawn":
      return buildSubagentSpawn(request);
    case "pre-tool-use": {
      const toolName = readToolName(request.input, request.hints?.toolName);
      const { toolNames } = capabilitiesFor(
        request.platform.id,
        request.platform.adapterId,
      );
      if (toolName === null) {
        return buildSubagentSpawn(request);
      }
      if (toolNames.edit.includes(toolName)) {
        return buildPreEdit(request);
      }
      if (toolNames.shell.includes(toolName)) {
        return buildPreShell(request);
      }
      if (toolNames.subagent.includes(toolName)) {
        return buildSubagentSpawn(request);
      }
      return notImplemented(request);
    }
    default:
      return notImplemented(request);
  }
}

function notImplemented(request: ContextRequest): ContextResponse {
  const diagnostics: Diagnostic[] = [
    diagnostic(
      "context.event_not_implemented",
      "warn",
      `context event '${request.event}' is not implemented yet`,
    ),
  ];
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: request.event,
    platform: request.platform.id,
    projectRoot: request.projectRoot,
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
    envelope: "none",
    degraded: true,
    diagnostics,
  };
}

export interface RenderOptions {
  /** Force a specific envelope, mainly for tests. */
  envelope?: string;
}

export function renderContext(
  response: ContextResponse,
  options: RenderOptions = {},
): string {
  const text = response.blocks.map((block) => block.text).join("\n\n");
  const envelope = options.envelope ?? response.envelope;
  switch (envelope) {
    case "kiro-plain":
      return text.length > 0 ? `${text}\n` : "";
    case "shell-allow":
      return JSON.stringify({ permission: "allow" });
    case "mutation-plan":
      return JSON.stringify({ mutations: response.mutations });
    case "zcode-hook-v1":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName(response.event),
          additionalContext: text,
        },
      });
    case "gemini-before-agent":
      if (text.length === 0) {
        return "";
      }
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "BeforeAgent",
          additionalContext: text,
        },
      });
    case "claude-hook-v2":
      if (text.length === 0) {
        return "";
      }
      // SessionStart accepts the dual-key shape; per-turn hooks must not emit
      // the top-level alias or hosts would see the breadcrumb twice.
      if (response.event === "session-start") {
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: text,
          },
          additional_context: text,
        });
      }
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName(response.event),
          additionalContext: text,
        },
      });
    case "none":
    default:
      return text;
  }
}

function readToolName(input: unknown, hint?: string): string | null {
  if (typeof hint === "string" && hint.trim()) {
    return hint.trim().toLowerCase();
  }
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const data = input as Record<string, unknown>;
  const name = data.tool_name ?? data.toolName;
  return typeof name === "string" ? name.toLowerCase() : null;
}

function eventName(event: ContextEvent): string {
  switch (event) {
    case "session-start":
      return "SessionStart";
    case "user-prompt":
      return "UserPromptSubmit";
    case "pre-tool-use":
      return "PreToolUse";
    default:
      return "SessionStart";
  }
}
