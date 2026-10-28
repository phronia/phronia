/**
 * Short-lived shell tickets.
 *
 * A hook writes a ticket just before a shell command runs, because no host
 * exports session identity into shell children. A ticket counts only when it is
 * fresh, inside this repository, and matches the `task.py` subcommand now
 * running — and only when exactly one key matches. Two concurrent windows
 * therefore both degrade instead of one inheriting the other's pointer.
 *
 * The Python implementation deletes expired tickets as a side effect. This
 * read-only layer only ignores them and reports a diagnostic.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { listDir, readJson, realPath, type FsLike } from "../fs.js";
import { taskRefsMatch } from "../tasks/refs.js";
import { asObject, stringValue } from "./key.js";
import { parseTaskInvocation } from "./commands.js";

export {
  LEASE_ACTIONS,
  TASK_SESSION_COMMANDS,
  WORKSPACE_ACTIONS,
} from "./commands.js";

export const SHELL_TICKET_TTL_SECONDS = 30;
const LEGACY_CURSOR_SHELL = "cursor-shell";

export interface ShellTicket {
  platform?: string;
  context_key?: string;
  cwd?: string;
  host_cwd?: string;
  command?: string;
  subcommands?: { name?: string; action?: string; task_ref?: string }[];
  created_at_epoch?: number;
  expires_at_epoch?: number;
}

export interface TicketLookupOptions {
  root: string;
  argv: readonly string[];
  now: number;
  io: FsLike;
}

export interface TicketLookupResult {
  key: string | null;
  diagnostics: readonly Diagnostic[];
}

export function lookupShellTicketContextKey(
  options: TicketLookupOptions,
): TicketLookupResult {
  const diagnostics: Diagnostic[] = [];
  const dirs = [
    path.join(options.root, LAYOUT.paths.shellTickets),
    path.join(
      options.root,
      LAYOUT.paths.runtime,
      LEGACY_CURSOR_SHELL,
    ),
  ];
  const candidates = new Set<string>();

  for (const dir of dirs) {
    for (const entry of listDir(options.io, dir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const ticketPath = path.join(dir, entry);
      const ticket = readJson<ShellTicket>(options.io, ticketPath);
      if (!ticket) {
        diagnostics.push(
          diagnostic(
            "state.session.ticket_corrupt",
            "warn",
            "shell ticket is not valid JSON",
            { path: ticketPath },
          ),
        );
        continue;
      }
      if (!ticketIsFresh(ticket, ticketPath, options.now, diagnostics)) {
        continue;
      }
      if (!ticketCwdMatchesRepo(ticket, options.root, options.io)) {
        continue;
      }
      if (!pendingTicketMatchesArgs(ticket, options.root, options.argv, options.io)) {
        continue;
      }
      const key = stringValue(ticket.context_key);
      if (key) {
        candidates.add(key);
      }
    }
  }

  if (candidates.size === 1) {
    return { key: [...candidates][0] ?? null, diagnostics };
  }
  if (candidates.size > 1) {
    diagnostics.push(
      diagnostic(
        "state.session.ticket_ambiguous",
        "warn",
        `${candidates.size} fresh shell tickets match; refusing to choose one`,
      ),
    );
  }
  return { key: null, diagnostics };
}

function ticketIsFresh(
  ticket: ShellTicket,
  ticketPath: string,
  now: number,
  diagnostics: Diagnostic[],
): boolean {
  const expiresAt = ticket.expires_at_epoch;
  if (typeof expiresAt === "number" && expiresAt < now) {
    diagnostics.push(
      diagnostic("state.session.ticket_expired", "info", "shell ticket expired", {
        path: ticketPath,
      }),
    );
    return false;
  }
  const createdAt = ticket.created_at_epoch;
  if (typeof createdAt === "number") {
    if (now - createdAt <= SHELL_TICKET_TTL_SECONDS) {
      return true;
    }
    diagnostics.push(
      diagnostic("state.session.ticket_expired", "info", "shell ticket is stale", {
        path: ticketPath,
      }),
    );
    return false;
  }
  return true;
}

function ticketCwdMatchesRepo(
  ticket: ShellTicket,
  root: string,
  io: FsLike,
): boolean {
  const cwd = stringValue(ticket.cwd);
  if (!cwd) {
    return true;
  }
  const rootReal = realPath(io, path.resolve(root)) ?? path.resolve(root);
  const cwdReal = realPath(io, path.resolve(cwd)) ?? path.resolve(cwd);
  const relative = path.relative(rootReal, cwdReal);
  return (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function pendingTicketMatchesArgs(
  ticket: ShellTicket,
  root: string,
  argv: readonly string[],
  io: FsLike,
): boolean {
  if (!Array.isArray(ticket.subcommands)) {
    return false;
  }
  const invocation = parseTaskInvocation(argv);
  if (invocation === null) {
    return false;
  }
  for (const subcommand of ticket.subcommands) {
    const entry = asObject(subcommand);
    if (!entry || stringValue(entry.name) !== invocation.name) {
      continue;
    }
    // Old tickets predate `action`; only a present action constrains the match.
    const ticketAction = stringValue(entry.action);
    if (ticketAction !== null && ticketAction !== invocation.action) {
      continue;
    }
    if (!invocation.requiresRef) {
      return true;
    }
    if (taskRefsMatch(stringValue(entry.task_ref), invocation.ref, root, io)) {
      return true;
    }
  }
  return false;
}
