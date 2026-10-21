/**
 * Active-task resolution from session runtime state.
 *
 * Ported from `common/active_task.py`. A stale pointer is returned as stale;
 * missing identity never infers ownership from unrelated session files, and
 * the single-session fallback is opt-in and refuses 0 or >=2 files.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { isDirectory, listDir, readJson, type FsLike } from "../fs.js";
import { resolveTaskRef } from "../tasks/refs.js";
import {
  asObject,
  resolveContextKey,
  stringValue,
  type ContextKeyResult,
} from "./key.js";
import { lookupShellTicketContextKey } from "./tickets.js";

export interface RawSessionFile {
  key: string;
  filePath: string;
  platform?: string;
  current_task?: string;
  current_run?: unknown;
  last_seen_at?: string;
  raw: Record<string, unknown>;
}

export type ActiveTaskSource = "session" | "session-fallback" | "hint" | "none";

export interface ActiveTaskState {
  taskPath: string | null;
  sourceType: ActiveTaskSource;
  contextKey: string | null;
  stale: boolean;
  /** Human-readable source label, e.g. `session:claude_abc`. */
  source: string;
  diagnostics: readonly Diagnostic[];
}

export interface ResolveActiveTaskOptions {
  root: string;
  input?: unknown;
  platform?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  io: FsLike;
  /** Required for shell-ticket identity; omit to disable the ticket bridge. */
  argv?: readonly string[];
  now?: number;
  allowSingleSessionFallback?: boolean;
  allowEnvironmentContext?: boolean;
  /**
   * Explicit task reference from the harness payload (for example an
   * `Active task: <path>` line in a dispatch prompt). It wins over the
   * session pointer and never falls back to inference.
   */
  taskRef?: string | null;
}

export function resolveActiveTask(
  options: ResolveActiveTaskOptions,
): ActiveTaskState {
  const diagnostics: Diagnostic[] = [];
  const now = options.now ?? Date.now() / 1000;
  const argv = options.argv;

  const shellTicket =
    argv === undefined
      ? undefined
      : (): string | null => {
          const result = lookupShellTicketContextKey({
            root: options.root,
            argv,
            now,
            io: options.io,
          });
          diagnostics.push(...result.diagnostics);
          return result.key;
        };

  const resolved: ContextKeyResult = resolveContextKey(options.input, {
    platform: options.platform,
    env: options.env,
    allowEnvironmentContext: options.allowEnvironmentContext,
    shellTicket,
  });

  if (resolved.key === null) {
    diagnostics.push(
      diagnostic(
        "state.session.no_identity",
        "warn",
        "no session identity was available; the active task cannot be resolved",
      ),
    );
  }

  if (options.taskRef) {
    const hinted = activeFromRef(
      options.taskRef,
      options.root,
      "hint",
      resolved.key,
      options.io,
      diagnostics,
    );
    if (hinted.taskPath) {
      return hinted;
    }
  }

  if (resolved.key) {
    const session = readSessionFile(options.root, resolved.key, options.io, diagnostics);
    const taskRef = stringValue(session?.current_task);
    const active = activeFromRef(
      taskRef,
      options.root,
      "session",
      resolved.key,
      options.io,
      diagnostics,
    );
    if (active.taskPath) {
      return active;
    }
  }

  if (options.allowSingleSessionFallback) {
    const fallback = resolveSingleSessionFallback(
      options.root,
      options.io,
      diagnostics,
    );
    if (fallback) {
      return fallback;
    }
  }

  return {
    taskPath: null,
    sourceType: "none",
    contextKey: resolved.key,
    stale: false,
    source: "none",
    diagnostics,
  };
}

export function readSessionFile(
  root: string,
  contextKey: string,
  io: FsLike,
  diagnostics: Diagnostic[] = [],
): RawSessionFile | null {
  const filePath = path.join(root, LAYOUT.paths.sessions, `${contextKey}.json`);
  const raw = readJson<Record<string, unknown>>(io, filePath);
  if (!raw) {
    return null;
  }
  if (!asObject(raw)) {
    diagnostics.push(
      diagnostic("state.session.file_corrupt", "warn", "session file is not an object", {
        path: filePath,
      }),
    );
    return null;
  }
  return {
    key: contextKey,
    filePath,
    platform: stringValue(raw.platform) ?? undefined,
    current_task: stringValue(raw.current_task) ?? undefined,
    current_run: raw.current_run,
    last_seen_at: stringValue(raw.last_seen_at) ?? undefined,
    raw,
  };
}

export function listSessionFiles(
  root: string,
  io: FsLike,
  diagnostics: Diagnostic[] = [],
): RawSessionFile[] {
  const dir = path.join(root, LAYOUT.paths.sessions);
  const files: RawSessionFile[] = [];
  for (const entry of listDir(io, dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const key = entry.slice(0, -".json".length);
    const file = readSessionFile(root, key, io, diagnostics);
    if (file) {
      files.push(file);
    }
  }
  return files.sort((left, right) => left.key.localeCompare(right.key));
}

function resolveSingleSessionFallback(
  root: string,
  io: FsLike,
  diagnostics: Diagnostic[],
): ActiveTaskState | null {
  const sessions = listSessionFiles(root, io, diagnostics);
  if (sessions.length !== 1) {
    diagnostics.push(
      diagnostic(
        "state.session.no_fallback",
        "info",
        sessions.length === 0
          ? "no session files available for the fallback"
          : `${sessions.length} session files exist; refusing to pick one`,
      ),
    );
    return null;
  }
  const session = sessions[0];
  const taskRef = session ? stringValue(session.current_task) : null;
  if (!session || !taskRef) {
    return null;
  }
  const active = activeFromRef(
    taskRef,
    root,
    "session-fallback",
    session.key,
    io,
    diagnostics,
  );
  return active.taskPath ? active : null;
}

function activeFromRef(
  taskRef: string | null,
  root: string,
  sourceType: ActiveTaskSource,
  contextKey: string | null,
  io: FsLike,
  diagnostics: Diagnostic[],
): ActiveTaskState {
  if (!taskRef) {
    return {
      taskPath: null,
      sourceType: "none",
      contextKey,
      stale: false,
      source: "none",
      diagnostics,
    };
  }
  const resolved = resolveTaskRef(taskRef, root, io);
  const stale = resolved === null || !isDirectory(io, resolved.real);
  if (stale) {
    diagnostics.push(
      diagnostic(
        "state.task.stale_pointer",
        "info",
        `active task pointer does not resolve to a directory: ${taskRef}`,
      ),
    );
  }
  const source =
    sourceType === "none"
      ? "none"
      : contextKey
        ? `${sourceType}:${contextKey}`
        : sourceType;
  return {
    taskPath: taskRef,
    sourceType,
    contextKey,
    stale,
    source,
    diagnostics,
  };
}
