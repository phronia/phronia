/**
 * GitPort adapter (design.md §18.2, §25.1).
 *
 * Every call uses `execFile*` — never a shell string — so paths and refs
 * cannot be reinterpreted by a shell. Failures become coded `GitError`s or
 * structured results; this module never prints, never exits, and never reads
 * `process.cwd()`.
 *
 * Timeouts follow §25.1: probes 3s, worktree mutations 15s, network 60s.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveCommonDir } from "@phronia/core/state";

export const GIT_PROBE_TIMEOUT_MS = 3_000;
export const GIT_WORKTREE_TIMEOUT_MS = 15_000;
export const GIT_NETWORK_TIMEOUT_MS = 60_000;
export const GIT_REBASE_TIMEOUT_MS = 60_000;

export type GitErrorCode = "GIT_UNAVAILABLE" | "GIT_FAILED";

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandResult {
  readonly file: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the binary could not be spawned (ENOENT/EACCES). */
  readonly spawnError: string | null;
}

/** Injectable process runner; tests replace this instead of spawning git. */
export type CommandExec = (
  file: string,
  args: readonly string[],
  options: CommandOptions,
) => CommandResult;

export const defaultCommandExec: CommandExec = (file, args, options) => {
  try {
    const stdout = execFileSync(file, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...options.env,
        // Never block on an interactive credential prompt.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return {
      file,
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      spawnError: null,
    };
  } catch (error) {
    const failure = error as ExecFileFailure;
    const timedOut =
      failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM";
    return {
      file,
      exitCode:
        typeof failure.status === "number" ? failure.status : null,
      stdout: text(failure.stdout),
      stderr: text(failure.stderr),
      timedOut,
      spawnError:
        failure.code === "ENOENT" || failure.code === "EACCES"
          ? failure.code
          : null,
    };
  }
};

interface ExecFileFailure {
  readonly code?: string | number;
  readonly status?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly message?: string;
}

function text(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : value.toString("utf8");
}

export interface GitCommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

/** Injectable git runner; tests use this to avoid real processes. */
export type GitExec = (
  args: readonly string[],
  options: GitCommandOptions,
) => GitCommandResult;

export const defaultGitExec: GitExec = (args, options) => {
  const result = defaultCommandExec("git", args, options);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
  };
};

export interface GitErrorDetails {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Coded git failure. `message` is safe to show to a user. */
export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(code: GitErrorCode, message: string, details: GitErrorDetails) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
    this.timedOut = details.timedOut;
  }

  /** Best available human-readable detail (stderr, else message). */
  get detail(): string {
    const stderr = this.stderr.trim();
    return stderr === "" ? this.message : stderr;
  }
}

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface WorktreeAddOptions {
  readonly cwd: string;
  readonly path: string;
  readonly branch?: string;
  readonly base?: string;
  /** Create `branch` with `-b` instead of checking it out. */
  readonly createBranch?: boolean;
  readonly force?: boolean;
  readonly detach?: boolean;
}

export interface WorktreeRemoveOptions {
  readonly cwd: string;
  readonly path: string;
  readonly force?: boolean;
}

export interface GitOpResult {
  readonly ok: boolean;
  readonly code?: GitErrorCode;
  readonly detail?: string;
}

export interface RebaseResult extends GitOpResult {
  readonly conflicts: readonly string[];
}

export interface GitStatus {
  readonly clean: boolean;
  readonly dirtyPaths: number;
}

export interface GitPort {
  status(cwd: string): GitStatus;
  /** Raw `git status --porcelain` lines (tracked and untracked). */
  statusPorcelain(cwd: string): readonly string[];
  /**
   * True when `git check-ignore --no-index` matches the path. Used as the
   * safety check before an explicitly configured input may be ignored.
   */
  checkIgnore(cwd: string, path: string): boolean;
  /** Repo-relative paths changed between two refs (`from..to`). */
  diffNames(cwd: string, from: string, to: string): readonly string[];
  add(cwd: string, paths: readonly string[]): GitOpResult;
  commit(cwd: string, message: string, paths: readonly string[]): GitOpResult;
  branch(cwd: string): string;
  head(cwd: string): string;
  resolveRef(cwd: string, ref: string): string;
  isAncestor(cwd: string, ancestor: string, ref: string): boolean;
  isBare(cwd: string): boolean;
  isShallow(cwd: string): boolean;
  commonDir(cwd: string): string;
  mainWorktreeRoot(cwd: string): string;
  worktreeList(cwd: string): readonly WorktreeInfo[];
  worktreeAdd(options: WorktreeAddOptions): void;
  worktreeRemove(options: WorktreeRemoveOptions): void;
  rebase(cwd: string, onto: string): RebaseResult;
  rebaseAbort(cwd: string): GitOpResult;
  mergeFf(cwd: string, ref: string): GitOpResult;
  fetch(cwd: string, remote: string, ref: string): GitOpResult;
  push(cwd: string, remote: string, branch: string): GitOpResult;
}

export function createGitPort(exec: GitExec = defaultGitExec): GitPort {
  const probe = (args: readonly string[], cwd: string): GitCommandResult =>
    exec(args, { cwd, timeoutMs: GIT_PROBE_TIMEOUT_MS });
  const probeOk = (args: readonly string[], cwd: string): string =>
    requireSuccess(probe(args, cwd), args);
  const operation = (
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): GitOpResult => toOpResult(exec(args, { cwd, timeoutMs }));

  return {
    status(cwd: string): GitStatus {
      const args = ["status", "--porcelain"];
      const output = probeOk(args, cwd);
      const dirtyPaths = output
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0).length;
      return { clean: dirtyPaths === 0, dirtyPaths };
    },

    statusPorcelain(cwd: string): readonly string[] {
      return probeOk(["status", "--porcelain"], cwd)
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    },

    checkIgnore(cwd: string, target: string): boolean {
      // Exit 0 = ignored, 1 = not ignored; any other failure is "not ignored"
      // so a broken git invocation can never weaken the dirty check.
      const result = probe(
        ["check-ignore", "--no-index", "--quiet", "--", target],
        cwd,
      );
      if (result.spawnError !== null || result.timedOut) {
        return false;
      }
      return result.exitCode === 0;
    },

    diffNames(cwd: string, from: string, to: string): readonly string[] {
      return probeOk(["diff", "--name-only", `${from}..${to}`], cwd)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    add(cwd: string, paths: readonly string[]): GitOpResult {
      return operation(["add", "--", ...paths], cwd, GIT_WORKTREE_TIMEOUT_MS);
    },

    commit(cwd: string, message: string, paths: readonly string[]): GitOpResult {
      return operation(
        ["commit", "-m", message, "--", ...paths],
        cwd,
        GIT_WORKTREE_TIMEOUT_MS,
      );
    },

    branch(cwd: string): string {
      // Empty string means detached HEAD; callers must treat that as a refusal.
      return probeOk(["branch", "--show-current"], cwd).trim();
    },

    head(cwd: string): string {
      return probeOk(["rev-parse", "HEAD"], cwd).trim();
    },

    resolveRef(cwd: string, ref: string): string {
      return probeOk(["rev-parse", "--verify", ref], cwd).trim();
    },

    isAncestor(cwd: string, ancestor: string, ref: string): boolean {
      const args = ["merge-base", "--is-ancestor", ancestor, ref];
      const result = probe(args, cwd);
      if (result.spawnError !== null || result.timedOut) {
        throw toGitError(result, args);
      }
      if (result.exitCode === 0) {
        return true;
      }
      if (result.exitCode === 1) {
        return false;
      }
      throw toGitError(result, args);
    },

    isBare(cwd: string): boolean {
      return (
        probeOk(["rev-parse", "--is-bare-repository"], cwd).trim() === "true"
      );
    },

    isShallow(cwd: string): boolean {
      return (
        probeOk(["rev-parse", "--is-shallow-repository"], cwd).trim() ===
        "true"
      );
    },

    commonDir(cwd: string): string {
      const raw = probeOk(["rev-parse", "--git-common-dir"], cwd);
      return resolveCommonDir(raw, cwd);
    },

    mainWorktreeRoot(cwd: string): string {
      const worktrees = this.worktreeList(cwd);
      const main = worktrees[0];
      if (main === undefined) {
        throw new GitError("GIT_FAILED", "no worktrees reported by git", {
          args: ["worktree", "list", "--porcelain"],
          exitCode: null,
          stderr: "",
          timedOut: false,
        });
      }
      return path.resolve(main.path);
    },

    worktreeList(cwd: string): readonly WorktreeInfo[] {
      const output = probeOk(["worktree", "list", "--porcelain"], cwd);
      return parseWorktreeList(output);
    },

    worktreeAdd(options: WorktreeAddOptions): void {
      const args = buildWorktreeAddArgs(options);
      const result = exec(args, {
        cwd: options.cwd,
        timeoutMs: GIT_WORKTREE_TIMEOUT_MS,
      });
      requireSuccess(result, args);
    },

    worktreeRemove(options: WorktreeRemoveOptions): void {
      const args = [
        "worktree",
        "remove",
        ...(options.force === true ? ["--force"] : []),
        options.path,
      ];
      const result = exec(args, {
        cwd: options.cwd,
        timeoutMs: GIT_WORKTREE_TIMEOUT_MS,
      });
      requireSuccess(result, args);
    },

    rebase(cwd: string, onto: string): RebaseResult {
      const args = ["rebase", onto];
      const result = exec(args, {
        cwd,
        timeoutMs: GIT_REBASE_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && result.spawnError === null && !result.timedOut) {
        return { ok: true, conflicts: [] };
      }
      // A conflict is a normal outcome: report the unmerged paths so the
      // service can classify and abort. Do not abort or rewrite anything here.
      const failure = failureFields(result);
      const combined = `${result.stderr}\n${result.stdout}`.trim();
      return {
        ok: false,
        code: failure.code,
        detail: combined === "" ? failure.detail : combined,
        conflicts: readUnmergedPaths(cwd, exec),
      };
    },

    rebaseAbort(cwd: string): GitOpResult {
      return operation(["rebase", "--abort"], cwd, GIT_REBASE_TIMEOUT_MS);
    },

    mergeFf(cwd: string, ref: string): GitOpResult {
      return operation(
        ["merge", "--ff-only", ref],
        cwd,
        GIT_NETWORK_TIMEOUT_MS,
      );
    },

    fetch(cwd: string, remote: string, ref: string): GitOpResult {
      const args = ["fetch", remote, ...(ref.trim() === "" ? [] : [ref])];
      return operation(args, cwd, GIT_NETWORK_TIMEOUT_MS);
    },

    push(cwd: string, remote: string, branch: string): GitOpResult {
      return operation(
        ["push", "--set-upstream", remote, branch],
        cwd,
        GIT_NETWORK_TIMEOUT_MS,
      );
    },
  };
}

/** Default process-backed port. */
export const git: GitPort = createGitPort();

function buildWorktreeAddArgs(options: WorktreeAddOptions): readonly string[] {
  const args = ["worktree", "add"];
  if (options.force === true) {
    args.push("--force");
  }
  if (options.createBranch === true && options.branch !== undefined) {
    args.push("-b", options.branch, options.path);
    if (options.base !== undefined) {
      args.push(options.base);
    }
    return args;
  }
  if (options.detach === true) {
    args.push("--detach");
  }
  args.push(options.path);
  if (options.branch !== undefined) {
    args.push(options.branch);
  } else if (options.base !== undefined) {
    args.push(options.base);
  }
  return args;
}

function readUnmergedPaths(cwd: string, exec: GitExec): readonly string[] {
  const result = exec(["diff", "--name-only", "--diff-filter=U"], {
    cwd,
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseWorktreeList(output: string): readonly WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
  } | null = null;

  const flush = (): void => {
    if (current !== null) {
      entries.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare,
        detached: current.detached,
        locked: current.locked,
        prunable: current.prunable,
      });
      current = null;
    }
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

function requireSuccess(
  result: GitCommandResult,
  args: readonly string[],
): string {
  if (result.spawnError !== null || result.timedOut) {
    throw toGitError(result, args);
  }
  if (result.exitCode !== 0) {
    throw toGitError(result, args);
  }
  return result.stdout;
}

function toGitError(
  result: GitCommandResult,
  args: readonly string[],
): GitError {
  const command = `git ${args.join(" ")}`;
  const detail = result.stderr.trim();
  const code: GitErrorCode =
    result.spawnError !== null || result.timedOut
      ? "GIT_UNAVAILABLE"
      : "GIT_FAILED";
  const reason =
    result.spawnError !== null
      ? `git is unavailable (${result.spawnError})`
      : result.timedOut
        ? `${command} timed out`
        : detail === ""
          ? `${command} failed with exit code ${String(result.exitCode)}`
          : detail;
  return new GitError(code, reason, {
    args,
    exitCode: result.exitCode,
    stderr: result.stderr,
    timedOut: result.timedOut,
  });
}

function toOpResult(result: GitCommandResult): GitOpResult {
  if (result.exitCode === 0 && result.spawnError === null && !result.timedOut) {
    return { ok: true };
  }
  return { ok: false, ...failureFields(result) };
}

function failureFields(result: GitCommandResult): {
  code: GitErrorCode;
  detail: string;
} {
  const code: GitErrorCode =
    result.spawnError !== null || result.timedOut
      ? "GIT_UNAVAILABLE"
      : "GIT_FAILED";
  const detail =
    result.spawnError !== null
      ? `git is unavailable (${result.spawnError})`
      : result.timedOut
        ? "git command timed out"
        : result.stderr.trim() === ""
          ? `git exited with code ${String(result.exitCode)}`
          : result.stderr.trim();
  return { code, detail };
}
