/**
 * Pre-shell session ticket.
 *
 * The hook runs just before a shell command; this computes a short-lived
 * ticket the CLI consumes later. Core returns the ticket as an effect and never
 * writes it (the shim owns IO).
 *
 * Unlike the Python implementation this does not delete expired tickets on
 * read; cleanup belongs to the writer side.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { openState } from "../state/index.js";
import { CORE_VERSION } from "../version.js";
import {
  CONTEXT_SCHEMA_VERSION,
  type Effect,
  type ContextRequest,
  type ContextResponse,
} from "./types.js";
import { diagnostic, type Diagnostic } from "../state/diagnostics.js";
import { taskInvocationAt } from "../state/session/commands.js";

const TICKET_TTL_SECONDS = 30;
const CONTEXT_IDENTITY_KEYS = [
  "session_id",
  "sessionId",
  "sessionID",
  "conversation_id",
  "conversationId",
  "conversationID",
  "transcript_path",
  "transcriptPath",
  "transcript",
] as const;

export interface ShellSubcommand {
  /** `start|current|finish` for task.py, or `workspace|lease` for the CLI. */
  name: string;
  /** The verb now running (`start`, `ensure`, `acquire`, ...). */
  action?: string;
  task_ref?: string;
}

export interface ShellCommandInfo {
  command: string;
  /** Set when the payload is Cursor's shell-execution shape. */
  response: "permission-allow" | null;
  subcommands: ShellSubcommand[];
}

export function buildPreShell(request: ContextRequest): ContextResponse {
  const root = path.resolve(request.projectRoot);
  const info = readShellCommand(request.input);
  if (!info || info.subcommands.length === 0) {
    return emptyResponse(request, root, info?.response ?? null, [
      diagnostic(
        "context.pre_shell.not_task_command",
        "info",
        "command does not invoke task.py start/current/finish",
      ),
    ]);
  }

  const input = objectInput(request.input);
  if (!input || !hasContextIdentity(input)) {
    return emptyResponse(request, root, info.response, [
      diagnostic(
        "context.pre_shell.no_identity",
        "warn",
        "hook payload carries no top-level session identity",
      ),
    ]);
  }

  const state = openState({ root, env: request.env });
  const key = state.sessions.resolveKey(input, {
    platform: request.platform.id,
  });
  if (!key.key) {
    return emptyResponse(request, root, info.response, [
      diagnostic(
        "context.pre_shell.no_context_key",
        "warn",
        "no context key could be resolved for the pending shell command",
      ),
    ]);
  }

  const canonicalRoot = safeRealpath(root);
  const now = request.options?.now ?? Date.now() / 1000;
  const digest = createHash("sha256")
    .update(`${key.key}\0${info.command}\0${now}`)
    .digest("hex")
    .slice(0, 16);
  const ticketPath = path.join(
    root,
    LAYOUT.paths.shellTickets,
    `${Math.floor(now * 1000)}-${digest}.json`,
  );
  const ticket = {
    platform: key.platform,
    context_key: key.key,
    conversation_id: stringField(input.conversation_id),
    session_id: stringField(input.session_id),
    generation_id: stringField(input.generation_id),
    cwd: canonicalRoot,
    host_cwd: stringField(input.cwd),
    command: info.command,
    subcommands: info.subcommands,
    created_at_epoch: now,
    expires_at_epoch: now + TICKET_TTL_SECONDS,
  };
  const effects: Effect[] = [
    {
      type: "shell-ticket",
      path: ticketPath,
      content: `${JSON.stringify(ticket, null, 2)}\n`,
      ttlSeconds: TICKET_TTL_SECONDS,
    },
  ];

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "pre-shell",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: key.key,
      keySource: key.source,
      task: null,
      taskSource: "none",
      taskStale: false,
    },
    blocks: [],
    mutations: [],
    effects,
    envelope: info.response === "permission-allow" ? "shell-allow" : "none",
    degraded: false,
    diagnostics: [],
  };
}

export function readShellCommand(input: unknown): ShellCommandInfo | null {
  const data = objectInput(input);
  if (!data) {
    return null;
  }
  const topLevel = stringField(data.command);
  if (topLevel) {
    return {
      command: topLevel,
      response: "permission-allow",
      subcommands: extractTaskSubcommands(topLevel),
    };
  }
  for (const key of ["tool_input", "toolInput"]) {
    const toolInput = objectInput(data[key]);
    const command = toolInput ? stringField(toolInput.command) : null;
    if (command) {
      return {
        command,
        response: null,
        subcommands: extractTaskSubcommands(command),
      };
    }
  }
  return null;
}

export function extractTaskSubcommands(command: string): ShellSubcommand[] {
  const tokens = splitShell(command);
  if (!tokens) {
    return [];
  }
  const subcommands: ShellSubcommand[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const invocation = taskInvocationAt(tokens, index);
    if (invocation === null) continue;
    const item: ShellSubcommand = {
      name: invocation.name,
      action: invocation.action,
    };
    if (invocation.requiresRef && invocation.ref !== null) {
      item.task_ref = invocation.ref;
    }
    subcommands.push(item);
  }
  return subcommands;
}

/** POSIX-like shlex split; returns null on an unbalanced quote. */
export function splitShell(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && index + 1 < command.length) {
        index += 1;
        current += command[index] ?? "";
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      current += command[index] ?? "";
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) {
    return null;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function emptyResponse(
  request: ContextRequest,
  root: string,
  response: "permission-allow" | null,
  diagnostics: Diagnostic[],
): ContextResponse {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "pre-shell",
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
    envelope: response === "permission-allow" ? "shell-allow" : "none",
    degraded: false,
    diagnostics,
  };
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function hasContextIdentity(input: Record<string, unknown>): boolean {
  return CONTEXT_IDENTITY_KEYS.some((key) => stringField(input[key]) !== null);
}

function objectInput(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
