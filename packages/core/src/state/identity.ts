/**
 * Developer identity and journal lookup.
 *
 * `.developer` is intentionally gitignored (personal identity); a linked
 * worktree therefore inherits the main checkout's file by reading it, never by
 * copying it. Resolution order matches `common/paths.py`.
 */

import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { DiagnosticCollector, diagnostic, type Diagnostic } from "./diagnostics.js";
import { isDirectory, listDir, readText, type FsLike } from "./fs.js";
import { mainWorktreeRoot, type GitExec } from "./git.js";

export interface DeveloperState {
  name: string | null;
  source: "env" | "local" | "main-worktree" | "none";
  file: string | null;
  diagnostics: readonly Diagnostic[];
}

export interface JournalState {
  file: string | null;
  lineCount: number;
  diagnostics: readonly Diagnostic[];
}

export function readDeveloper(
  root: string,
  io: FsLike,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    exec?: GitExec;
  } = {},
): DeveloperState {
  const collected = new DiagnosticCollector();
  const env = options.env ?? process.env;
  const fromEnv = (env.PHRONIA_DEVELOPER ?? env.TRELLIS_DEVELOPER ?? "").trim();
  if (fromEnv) {
    return { name: fromEnv, source: "env", file: null, diagnostics: [] };
  }

  const localFile = path.join(root, LAYOUT.paths.developer);
  const local = readDeveloperFile(io, localFile);
  if (local) {
    return { name: local, source: "local", file: localFile, diagnostics: [] };
  }

  const mainRoot = mainWorktreeRoot(root, options.exec);
  if (mainRoot) {
    const mainFile = path.join(mainRoot, LAYOUT.paths.developer);
    const main = readDeveloperFile(io, mainFile);
    if (main) {
      return {
        name: main,
        source: "main-worktree",
        file: mainFile,
        diagnostics: [],
      };
    }
  }

  collected.add(
    diagnostic(
      "state.identity.missing",
      "info",
      "no developer identity found (env, local .developer, or main checkout)",
    ),
  );
  return { name: null, source: "none", file: null, diagnostics: collected.all() };
}

export function readJournal(
  root: string,
  developer: string | null,
  io: FsLike,
): JournalState {
  if (!developer) {
    return { file: null, lineCount: 0, diagnostics: [] };
  }
  const workspace = path.join(root, LAYOUT.paths.workspace, developer);
  if (!isDirectory(io, workspace)) {
    return { file: null, lineCount: 0, diagnostics: [] };
  }

  let latest: string | null = null;
  let highest = 0;
  for (const entry of listDir(io, workspace)) {
    if (!entry.startsWith("journal-") || !entry.endsWith(".md")) {
      continue;
    }
    const match = /(\d+)$/.exec(entry.slice(0, -3));
    if (!match) {
      continue;
    }
    const number = Number.parseInt(match[1] ?? "0", 10);
    if (number > highest) {
      highest = number;
      latest = path.join(workspace, entry);
    }
  }
  if (!latest) {
    return { file: null, lineCount: 0, diagnostics: [] };
  }
  const content = readText(io, latest);
  return {
    file: path.relative(root, latest).split(path.sep).join("/"),
    lineCount: content === null ? 0 : countLines(content),
    diagnostics: [],
  };
}

/** Python `str.splitlines()` semantics, including trailing-newline handling. */
export function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split(/\r\n|[\n\r\v\f\u2028\u2029]/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function readDeveloperFile(io: FsLike, file: string): string | null {
  const content = readText(io, file);
  if (content === null) {
    return null;
  }
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.startsWith("name=")) {
      return line.slice("name=".length).trim() || null;
    }
  }
  return null;
}
