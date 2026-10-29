/**
 * Filtered `git status` used by integrate and spec sync.
 *
 * `parallel.integration.ignored_inputs` names gitignored build inputs that are
 * materialized in every worktree (dependencies, SDK pins). Git's directory
 * ignore patterns do not match a symlink, so a symlink to an ignored directory
 * shows up as untracked and would block integration forever.
 *
 * A configured path is only removed when it passes a second safety check:
 * either it is a symlink, or `git check-ignore --no-index` confirms git itself
 * ignores it. There is deliberately no blanket untracked allow-list.
 */

import fs from "node:fs";
import path from "node:path";
import type { GitPort } from "../adapters/git.js";

export interface DirtyPathsResult {
  /** Remaining dirty paths; any non-empty value blocks integration. */
  readonly dirtyPaths: readonly string[];
  /** Configured ignored inputs that were safely removed. */
  readonly ignoredPaths: readonly string[];
  /** Set when a configured input matched but failed the safety check. */
  readonly warning: string | null;
}

export function readDirtyPaths(
  git: GitPort,
  cwd: string,
  ignoredInputs: readonly string[],
  mainRoot: string,
): DirtyPathsResult {
  const lines = git.statusPorcelain(cwd);
  const ignored = normalizePaths(ignoredInputs);
  const realMainRoot = safeRealpath(mainRoot) ?? path.resolve(mainRoot);
  const dirtyPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    const parsed = parseStatusLine(line);
    if (parsed === null) continue;
    const relative = parsed.path;
    const input = ignored.find(
      (candidate) =>
        candidate === relative || relative.startsWith(`${candidate}/`),
    );
    if (input === undefined) {
      dirtyPaths.push(relative);
      continue;
    }
    const absolute = path.join(cwd, relative);
    if (isSymlink(absolute)) {
      // A symlink is only safe when its resolved target stays inside the
      // repository. A link to /etc or an external cache is still dirty.
      const real = safeRealpath(absolute);
      if (real !== null && isWithin(realMainRoot, real)) {
        ignoredPaths.push(relative);
        continue;
      }
      warnings.push(
        `configured ignored input ${input} matched ${relative}, but its symlink target ${
          real === null ? "cannot be resolved" : `escapes the repository (${real})`
        }; treating it as dirty`,
      );
      dirtyPaths.push(relative);
      continue;
    }
    if (git.checkIgnore(cwd, relative)) {
      ignoredPaths.push(relative);
      continue;
    }
    warnings.push(
      `configured ignored input ${input} matched ${relative}, but it is neither a symlink nor git-ignored; treating it as dirty`,
    );
    dirtyPaths.push(relative);
  }

  return {
    dirtyPaths,
    ignoredPaths,
    warning: warnings.length === 0 ? null : warnings.join("; "),
  };
}

interface ParsedStatus {
  /** Repo-relative path (rename/copy target when applicable). */
  readonly path: string;
}

/**
 * Parse one `git status --porcelain` v1 line. Handles quoted paths and the
 * `old -> new` rename/copy form; a rename is a tracked change, so its new path
 * is what gets matched (and `git check-ignore` never ignores it).
 */
export function parseStatusLine(line: string): ParsedStatus | null {
  if (line.length < 4) return null;
  const rest = line.slice(3);
  if (rest.trim() === "") return null;
  const renamed = splitRename(rest);
  const target = renamed ?? rest;
  const parsed = unquotePath(target.trim());
  return parsed === "" ? null : { path: parsed };
}

function splitRename(value: string): string | null {
  let inQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && value.startsWith(" -> ", index)) {
      return value.slice(index + 4);
    }
  }
  return null;
}

function unquotePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeGitQuoted(trimmed.slice(1, -1)).replace(/\\/g, "/");
  }
  return trimmed.replace(/\\/g, "/");
}

/** Decode git's C-style path quoting (`\t`, `\n`, `\\`, `\"`, `\NNN`). */
function decodeGitQuoted(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1] ?? "";
    index += 1;
    if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (/[0-7]/.test(next)) {
      const octal = value.slice(index, index + 3);
      const code = Number.parseInt(octal, 8);
      if (Number.isFinite(code)) {
        out += String.fromCharCode(code);
        index += 2;
      } else {
        out += next;
      }
    } else {
      out += next;
    }
  }
  return out;
}

function normalizePaths(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim().replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((value) => value !== "");
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRealpath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
