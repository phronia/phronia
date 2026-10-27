/**
 * The single source of truth for Phronia's on-disk layout.
 *
 * Every TypeScript module that needs a workflow path goes through this object.
 * The Python side reads a generated `layout.json` (see scripts/gen-layout.mjs)
 * so the two runtimes cannot drift. B1 flips `rootDirName` from `.phronia` to
 * `.phronia`; until then the value stays old on purpose while call sites are
 * converted.
 */

import fs from "node:fs";
import path from "node:path";

export interface WorkspacePaths {
  /** Workflow root, e.g. `.phronia`. */
  readonly root: string;
  /** `config.yaml`. */
  readonly config: string;
  /** `workflow.md`. */
  readonly workflow: string;
  /** `spec/`. */
  readonly spec: string;
  /** `tasks/`. */
  readonly tasks: string;
  /** `tasks/archive/`. */
  readonly tasksArchive: string;
  /** `workspace/`. */
  readonly workspace: string;
  /** `scripts/`. */
  readonly scripts: string;
  /** `agents/`. */
  readonly agents: string;
  /** `.runtime/`. */
  readonly runtime: string;
  /** `.runtime/sessions/`. */
  readonly sessions: string;
  /** `.runtime/shell-tickets/`. */
  readonly shellTickets: string;
  /** `.template-hashes.json`. */
  readonly manifest: string;
  /** Runtime adapter manifest (`manifest.json`). */
  readonly adapterManifest: string;
  /** `.runtime/harness/`. */
  readonly handshakes: string;
  /** `.runtime/rules.json` (compiled rule ledger). */
  readonly rulesCompiled: string;
  /** `gate.yaml` (compiled fifth-level gate). */
  readonly gate: string;
  /** `worktrees/` (task workspaces, gitignored). */
  readonly worktrees: string;
  /** `.runtime/worktrees.json` (worktree registry). */
  readonly worktreeRegistry: string;
  /** `.version`. */
  readonly version: string;
  /** `.developer`. */
  readonly developer: string;
  /** `.current-task` (legacy, read-only compatibility). */
  readonly currentTask: string;
}

export interface WorkspaceLayout {
  /** Workflow root directory name. */
  readonly rootDirName: string;
  /** Product slug used for env prefixes, branch prefixes, package names. */
  readonly brand: string;
  /** npm scope, e.g. `@phronia`. */
  readonly packageScope: string;
  /** Environment variable prefix, e.g. `PHRONIA_`. */
  readonly envPrefix: string;
  /** Previous root directory, used only by `adopt` and diagnostics. */
  readonly legacyRootDirName: string;
  /** POSIX relative paths from the project root. */
  readonly paths: WorkspacePaths;
}

const ROOT = ".phronia";

export const LAYOUT: WorkspaceLayout = Object.freeze({
  rootDirName: ROOT,
  brand: "phronia",
  packageScope: "@phronia",
  envPrefix: "PHRONIA_",
  legacyRootDirName: ".trellis",
  paths: Object.freeze({
    root: ROOT,
    config: `${ROOT}/config.yaml`,
    workflow: `${ROOT}/workflow.md`,
    spec: `${ROOT}/spec`,
    tasks: `${ROOT}/tasks`,
    tasksArchive: `${ROOT}/tasks/archive`,
    workspace: `${ROOT}/workspace`,
    scripts: `${ROOT}/scripts`,
    agents: `${ROOT}/agents`,
    runtime: `${ROOT}/.runtime`,
    sessions: `${ROOT}/.runtime/sessions`,
    shellTickets: `${ROOT}/.runtime/shell-tickets`,
    manifest: `${ROOT}/.template-hashes.json`,
    adapterManifest: `${ROOT}/manifest.json`,
    handshakes: `${ROOT}/.runtime/harness`,
    rulesCompiled: `${ROOT}/.runtime/rules.json`,
    gate: `${ROOT}/gate.yaml`,
    worktrees: `${ROOT}/worktrees`,
    worktreeRegistry: `${ROOT}/.runtime/worktrees.json`,
    version: `${ROOT}/.version`,
    developer: `${ROOT}/.developer`,
    currentTask: `${ROOT}/.current-task`,
  }),
});

export type WorkspacePathKey = keyof WorkspacePaths;

/** Resolve a layout path against an explicit project root. */
export function projectPath(root: string, key: WorkspacePathKey): string {
  return path.join(root, LAYOUT.paths[key]);
}

/** Resolve an arbitrary relative path under the workflow root. */
export function workflowPath(root: string, ...segments: string[]): string {
  return path.join(root, LAYOUT.rootDirName, ...segments);
}

/** Walk up from `start` until a directory contains the workflow root. */
export function findProjectRoot(start: string): string | null {
  let directory = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(directory, LAYOUT.rootDirName))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** Resolve the nearest project root, throwing when none exists. */
export function resolveProjectRoot(start: string = process.cwd()): string {
  const root = findProjectRoot(start);
  if (!root) {
    throw new Error(
      `No ${LAYOUT.rootDirName}/ project found from ${path.resolve(start)}`,
    );
  }
  return root;
}
