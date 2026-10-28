/**
 * Task-command grammar shared by the pre-shell ticket writer and the ticket
 * reader.
 *
 * Two command shapes carry session identity:
 *
 * - `task.py <start|current|finish> [task-ref]`
 * - `phronia|trellis task workspace <verb> [task-ref]`
 * - `phronia|trellis task lease <verb> [task-ref]`
 *
 * The writer (`context/pre-shell.ts`) scans a shell line token by token; the
 * reader (`state/session/tickets.ts`) parses the CLI's own argv. Both must
 * agree on the verbs exactly, so the grammar lives here once. The Python
 * writer mirrors this table for cross-language reasons; it is intentionally
 * not shared.
 */

import path from "node:path";

export const TASK_SESSION_COMMANDS = new Set(["start", "current", "finish"]);

export const WORKSPACE_ACTIONS = new Set([
  "prepare",
  "ensure",
  "bind",
  "release",
  "reclaim",
]);

export const LEASE_ACTIONS = new Set(["acquire", "release", "heartbeat"]);

const WORKSPACE_REF_ACTIONS = new Set(["ensure", "bind"]);
const LEASE_REF_ACTIONS = new Set(["acquire", "release"]);
const CLI_EXECUTABLES = new Set(["phronia", "trellis"]);

export interface TaskInvocation {
  /** `start|current|finish` for task.py, or `workspace|lease` for the CLI. */
  readonly name: string;
  /** The verb now running (`start`, `ensure`, `acquire`, ...). */
  readonly action: string;
  readonly ref: string | null;
  /** Whether this verb requires a task ref to identify the ticket. */
  readonly requiresRef: boolean;
}

/** Basename without a `.js`/`.mjs`/`.cjs` wrapper suffix. */
export function executableName(token: string): string {
  const normalized = token.replace(/^["']|["']$/g, "");
  return path.basename(normalized).replace(/\.(?:c|m)?js$/i, "");
}

/**
 * Recognize a task command whose executable is `tokens[index]`.
 *
 * Returns null when the token is not an executable this grammar knows, or the
 * following tokens do not form a recognized command.
 */
export function taskInvocationAt(
  tokens: readonly string[],
  index: number,
): TaskInvocation | null {
  const executable = executableName(tokens[index] ?? "");
  if (executable === "task.py") {
    const name = tokens[index + 1];
    if (!name || !TASK_SESSION_COMMANDS.has(name)) return null;
    return {
      name,
      action: name,
      ref: tokens[index + 2] ?? null,
      requiresRef: name === "start",
    };
  }
  if (!CLI_EXECUTABLES.has(executable)) return null;
  if (tokens[index + 1] !== "task") return null;
  return cliInvocationAt(tokens, index + 2);
}

/**
 * Parse the CLI's own argv. Accepts `process.argv.slice(2)` (starts at `task`)
 * or the full argv with the executable first.
 */
export function parseTaskInvocation(
  argv: readonly string[],
): TaskInvocation | null {
  const tokens = argv
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return null;

  const first = executableName(tokens[0] ?? "");
  if (first === "task.py") {
    return taskInvocationAt(tokens, 0);
  }
  const index = CLI_EXECUTABLES.has(first) ? 1 : 0;
  if (tokens[index] !== "task") return null;
  return cliInvocationAt(tokens, index + 1);
}

function cliInvocationAt(
  tokens: readonly string[],
  groupIndex: number,
): TaskInvocation | null {
  const group = tokens[groupIndex];
  const action = tokens[groupIndex + 1];
  const ref = tokens[groupIndex + 2] ?? null;
  if (!group || !action) return null;

  if (group === "workspace" && WORKSPACE_ACTIONS.has(action)) {
    return {
      name: "workspace",
      action,
      ref,
      requiresRef: WORKSPACE_REF_ACTIONS.has(action),
    };
  }
  if (group === "lease" && LEASE_ACTIONS.has(action)) {
    return {
      name: "lease",
      action,
      ref,
      requiresRef: LEASE_REF_ACTIONS.has(action),
    };
  }
  return null;
}
