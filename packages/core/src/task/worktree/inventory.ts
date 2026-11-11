/**
 * Worktree inventory reconciliation (pure).
 *
 * `git worktree list` is the source of truth for which worktrees exist. The
 * shared registry is only task metadata for entries Phronia created. This
 * module unions the two views into four buckets so manual/platform worktrees
 * stop being invisible without silently claiming ownership of them.
 *
 * Persisted state stays exactly as the registry expects: only managed and
 * provisional entries are written back. `unmanaged` entries are derived and
 * never persisted.
 */

import {
  diagnostic,
  type Diagnostic,
} from "../../state/diagnostics.js";
import type { WorktreeRoot } from "../workspace/types.js";

export interface WorktreeRegistryEntryLike {
  readonly taskRef: string;
  readonly path: string;
  readonly branch: string;
  readonly kind?: "phronia" | "platform";
  readonly provisional?: boolean;
  readonly createdAt?: string;
  readonly taskId?: string;
}

export interface GitWorktreeFact {
  readonly path: string;
  readonly branch: string;
  readonly head?: string | null;
  readonly bare?: boolean;
}

export interface InventoryEntry extends WorktreeRegistryEntryLike {
  /** Registry entry with a non-empty taskRef. */
  readonly managed: boolean;
  /** Path lives under the resolved worktree root. */
  readonly insideRoot: boolean;
  /** Path lives outside the main checkout. */
  readonly outsideRepo: boolean;
  /** Present in `git worktree list`. */
  readonly exists: boolean;
  readonly head: string | null;
}

export interface ReconcileInput {
  readonly registry: readonly WorktreeRegistryEntryLike[];
  readonly git: readonly GitWorktreeFact[];
  readonly mainRoot: string;
  readonly root: Pick<WorktreeRoot, "absolute">;
  /**
   * Path key used for matching. Defaults to POSIX normalization. Adapters pass
   * a realpath-based key so `/private/var/...` and `/var/...` match on macOS
   * without rewriting the path that gets persisted.
   */
  readonly pathKey?: (value: string) => string;
}

export interface WorktreeInventory {
  readonly entries: readonly InventoryEntry[];
  readonly managed: readonly InventoryEntry[];
  readonly provisional: readonly InventoryEntry[];
  readonly unmanaged: readonly InventoryEntry[];
  readonly missing: readonly InventoryEntry[];
  /** Exactly what should be persisted back to the registry. */
  readonly persisted: readonly WorktreeRegistryEntryLike[];
  readonly diagnostics: readonly Diagnostic[];
}

export function reconcileWorktrees(input: ReconcileInput): WorktreeInventory {
  const diagnostics: Diagnostic[] = [];
  const keyOf = input.pathKey ?? normalizePath;
  const mainRoot = normalizePath(keyOf(input.mainRoot));
  const rootAbsolute = normalizePath(keyOf(input.root.absolute));

  const registryByPath = new Map<string, WorktreeRegistryEntryLike>();
  const seenTaskRefs = new Set<string>();
  const normalizedRegistry: WorktreeRegistryEntryLike[] = [];

  for (const entry of input.registry) {
    if (entry === null || typeof entry !== "object") continue;
    const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (rawPath === "") continue;
    const key = normalizePath(keyOf(rawPath));
    if (registryByPath.has(key)) continue;
    // `taskRef: ""` is not a unique key: multiple provisional workspaces must
    // coexist. Only a real task ref is an identity.
    if (entry.taskRef !== "" && seenTaskRefs.has(entry.taskRef)) continue;
    const normalized: WorktreeRegistryEntryLike = { ...entry, path: rawPath };
    registryByPath.set(key, normalized);
    if (entry.taskRef !== "") seenTaskRefs.add(entry.taskRef);
    normalizedRegistry.push(normalized);
  }

  const gitByPath = new Map<string, GitWorktreeFact>();
  for (const worktree of input.git) {
    if (worktree.bare === true) continue;
    const key = normalizePath(keyOf(worktree.path));
    if (key === mainRoot) continue;
    if (gitByPath.has(key)) continue;
    gitByPath.set(key, worktree);
  }

  const entries: InventoryEntry[] = [];
  const managed: InventoryEntry[] = [];
  const provisional: InventoryEntry[] = [];
  const unmanaged: InventoryEntry[] = [];
  const missing: InventoryEntry[] = [];

  for (const entry of normalizedRegistry) {
    const key = normalizePath(keyOf(entry.path));
    const git = gitByPath.get(key);
    const exists = git !== undefined;
    const inventoryEntry: InventoryEntry = {
      ...entry,
      managed: entry.taskRef !== "",
      insideRoot: isInside(rootAbsolute, key),
      outsideRepo: !isInside(mainRoot, key),
      exists,
      head: git?.head ?? null,
    };
    entries.push(inventoryEntry);
    if (!exists) {
      missing.push(inventoryEntry);
    } else if (inventoryEntry.managed) {
      managed.push(inventoryEntry);
    } else {
      provisional.push(inventoryEntry);
    }
  }

  for (const [key, worktree] of gitByPath) {
    if (registryByPath.has(key)) continue;
    const inventoryEntry: InventoryEntry = {
      taskRef: "",
      path: worktree.path,
      branch: worktree.branch,
      kind: "platform",
      provisional: false,
      managed: false,
      insideRoot: isInside(rootAbsolute, key),
      outsideRepo: !isInside(mainRoot, key),
      exists: true,
      head: worktree.head ?? null,
    };
    entries.push(inventoryEntry);
    unmanaged.push(inventoryEntry);
  }

  if (missing.length > 0) {
    diagnostics.push(
      diagnostic(
        "RUNTIME_WORKTREES_MISSING",
        "info",
        `dropped ${missing.length} registry entr${missing.length === 1 ? "y" : "ies"} no longer present in git worktree list`,
        { details: { paths: missing.map((entry) => entry.path) } },
      ),
    );
  }
  if (unmanaged.length > 0) {
    diagnostics.push(
      diagnostic(
        "RUNTIME_WORKTREES_UNMANAGED",
        "warn",
        `${unmanaged.length} git worktree${unmanaged.length === 1 ? "" : "s"} are outside the Phronia registry`,
        { details: { paths: unmanaged.map((entry) => entry.path) } },
      ),
    );
  }
  const outsideRoot = entries.filter(
    (entry) => entry.exists && !entry.insideRoot,
  ).length;
  if (outsideRoot > 0) {
    diagnostics.push(
      diagnostic(
        "RUNTIME_WORKTREES_OUTSIDE_ROOT",
        "warn",
        `${outsideRoot} worktree${outsideRoot === 1 ? "" : "s"} live outside the resolved root ${input.root.absolute}`,
        { details: { root: input.root.absolute } },
      ),
    );
  }

  return {
    entries,
    managed,
    provisional,
    unmanaged,
    missing,
    persisted: entries
      .filter((entry) => entry.exists && (entry.managed || entry.provisional))
      .map(toPersisted),
    diagnostics,
  };
}

function toPersisted(entry: InventoryEntry): WorktreeRegistryEntryLike {
  return {
    taskRef: entry.taskRef,
    path: entry.path,
    branch: entry.branch,
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    ...(entry.provisional === true ? { provisional: true } : {}),
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
  };
}

/** POSIX-style path normalization for comparison across platforms. */
export function normalizePath(value: string): string {
  const unc = value.startsWith("\\\\") || value.startsWith("//");
  let normalized = value.replace(/\\/g, "/");
  normalized = normalized.replace(/\/+/g, "/");
  if (unc && !normalized.startsWith("//")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized;
}

function isInside(parent: string, child: string): boolean {
  if (parent === "" || child === "") return false;
  if (parent === child) return false;
  const base = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(base);
}
