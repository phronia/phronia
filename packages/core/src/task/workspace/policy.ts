/**
 * Workspace decision matrix (design.md §4.2 and §4.6).
 *
 * The function answers one question: for this task, should the session reuse
 * the current checkout, attach to an existing worktree, create a new one, or
 * refuse? It never touches disk; the caller performs the claim/worktree work.
 *
 * Ordering matters:
 * 1. an existing worktree for the task always wins;
 * 2. invalid targets and branch mismatches refuse before any create;
 * 3. an occupied checkout pushes the task into a worktree;
 * 4. stale claims are never reclaimed while the checkout is dirty or the owner
 *    task is still active;
 * 5. a clean, unclaimed checkout is reused for a serial task.
 */

import type {
  WorkspaceClaim,
  WorkspaceDecision,
  WorkspacePolicyContext,
} from "./types.js";

const DEFAULT_WORKTREE_DIR = ".phronia/worktrees";

/**
 * Branch names that are integration refs, never a task's dedicated branch.
 *
 * Older `task.py start` recorded whatever was checked out (`main`), and an
 * integration ref may be `origin/main`. Treating either as a feature branch
 * makes `ensure` attempt a worktree on a branch main already holds.
 */
const NON_FEATURE_BRANCHES = new Set([
  "main",
  "master",
  "origin/main",
  "origin/master",
]);

/**
 * Whether `branch` is a real feature branch (`feat/...`, `phronia/...`).
 *
 * `main`, `master`, `origin/main`, `origin/master`, the configured integration
 * branch, and the currently checked-out main branch are all non-dedicated.
 */
export function isDedicatedFeatureBranch(
  branch: string | null | undefined,
  integrationBranch: string,
  currentMainBranch?: string | null,
): boolean {
  if (branch === null || branch === undefined) return false;
  const value = normalizeBranch(branch);
  if (value === "") return false;
  if (NON_FEATURE_BRANCHES.has(value)) return false;
  if (normalizeBranch(integrationBranch) === value) return false;
  if (
    currentMainBranch !== null &&
    currentMainBranch !== undefined &&
    normalizeBranch(currentMainBranch) === value
  ) {
    return false;
  }
  return true;
}

function normalizeBranch(value: string): string {
  let normalized = value.trim();
  while (normalized.startsWith("refs/heads/")) {
    normalized = normalized.slice("refs/heads/".length);
  }
  return normalized;
}

export function decideWorkspace(
  context: WorkspacePolicyContext,
): WorkspaceDecision {
  const task = context.task;
  const existing = findExistingWorktree(context);
  if (existing !== null) {
    if (existing.kind === "refuse") return existing.decision;
    if (task.branch !== null && task.branch !== undefined && existing.branch !== task.branch) {
      return refuse(
        "WORKSPACE_ATTACH_INVALID",
        `task ${task.ref} expects branch ${task.branch}, but ${existing.path} is on ${existing.branch}`,
        "attach the correct worktree or update task.branch",
      );
    }
    return {
      kind: "attach",
      path: existing.path,
      branch: existing.branch,
      reason: "task already has a worktree; reuse it instead of creating a second one",
    };
  }

  const target = resolveTarget(context);
  if (target.exists === true) {
    return refuse(
      "WORKSPACE_TARGET_EXISTS",
      `target worktree path already exists: ${target.path}`,
      "remove the existing directory, choose another path, or attach it explicitly",
    );
  }
  if (target.checkedOutAt !== null && target.checkedOutAt !== undefined) {
    return refuse(
      "WORKSPACE_TARGET_EXISTS",
      `branch ${target.branch} is already checked out at ${target.checkedOutAt}`,
      "use the existing worktree or remove it before creating a new one",
    );
  }
  const registered = (context.existingWorktrees ?? []).find(
    (entry) => entry.branch === target.branch && entry.taskRef !== task.ref,
  );
  if (registered !== undefined) {
    return refuse(
      "WORKSPACE_TARGET_EXISTS",
      `branch ${target.branch} is already registered at ${registered.path}`,
      "use the existing worktree or remove it before creating a new one",
    );
  }

  const policy = context.task.worktreePolicy ?? "auto";
  const batch = context.parallelBatchSize ?? 1;
  const needsIsolation =
    batch > 1 || policy === "always" || context.task.exclusive === true;
  const reuseDirty = context.reuseDirty === true || context.force === true;
  const claim = context.claim ?? null;

  if (claim !== null && claim.taskRef === task.ref) {
    if (needsIsolation) {
      return createDecision(
        context,
        target,
        "this task owns the current checkout but explicitly requires isolation",
      );
    }
    return {
      kind: "reuse-current",
      reason: "this task already owns the current checkout",
    };
  }

  if (claim !== null && claim.stale !== true) {
    if (claim.ownedByCurrent === true && claim.taskRef === null) {
      if (needsIsolation) {
        return createDecision(
          context,
          target,
          "the current session holds the checkout but the task requires isolation",
        );
      }
      return {
        kind: "reuse-current",
        reason: "the current session holds the checkout; bind the new task to it",
      };
    }
    return createOrRefuse(
      policy,
      context,
      target,
      `current checkout is owned by ${describeClaim(claim)}`,
    );
  }

  if (claim !== null) {
    if (context.mainDirty) {
      return createOrRefuse(
        policy,
        context,
        target,
        `stale-dirty: previous owner ${describeClaim(claim)} left uncommitted changes; never reclaim automatically`,
      );
    }
    if (claim.ownerActive === true) {
      return createOrRefuse(
        policy,
        context,
        target,
        `stale-owned: ${describeClaim(claim)} has an expired heartbeat but the task is still active`,
      );
    }
    return {
      kind: "reuse-current",
      reason: `stale-reclaimed: previous owner ${describeClaim(claim)} finished and the checkout is clean`,
    };
  }

  if (policy === "never") {
    if (context.mainDirty && !reuseDirty) {
      return refuse(
        "WORKSPACE_DIRTY_UNCLAIMED",
        "the current checkout has uncommitted changes and worktrees are disabled",
        "commit or stash the changes, or pass --reuse-dirty",
      );
    }
    if (needsIsolation) {
      return refuse(
        "WORKSPACE_WORKTREE_DISABLED",
        "parallel execution needs a worktree, but parallel.worktree is set to never",
        "set parallel.worktree to auto/always, or run the tasks serially",
      );
    }
    return {
      kind: "reuse-current",
      reason: "worktree policy is never; use the current checkout",
    };
  }

  if (context.mainDirty) {
    if (reuseDirty) {
      return {
        kind: "reuse-current",
        reason: "reusing the dirty checkout because --reuse-dirty/--force was passed",
      };
    }
    return createDecision(
      context,
      target,
      `dirty-unclaimed: the current checkout has ${
        context.mainDirtyPaths ?? 1
      } uncommitted path(s) and no claim`,
    );
  }

  if (needsIsolation) {
    return createDecision(
      context,
      target,
      batch > 1
        ? `task belongs to a parallel batch of ${batch}`
        : "explicit isolation was requested",
    );
  }

  return {
    kind: "reuse-current",
    reason: "the current checkout is clean and no other task is active",
  };
}

type ExistingWorktree =
  | { readonly path: string; readonly branch: string; readonly kind?: "phronia" | "platform" }
  | { readonly kind: "refuse"; readonly decision: WorkspaceDecision };

function findExistingWorktree(
  context: WorkspacePolicyContext,
): ExistingWorktree | null {
  const task = context.task;
  const supplied = task.worktree ?? null;
  if (supplied !== null) return supplied;

  const registry = context.existingWorktrees ?? [];
  const byTask = registry.find((entry) => entry.taskRef === task.ref);
  if (byTask !== undefined) return byTask;

  if (task.branch === null || task.branch === undefined) return null;
  const byBranch = registry.find((entry) => entry.branch === task.branch);
  if (byBranch === undefined) return null;
  if (byBranch.taskRef !== undefined && byBranch.taskRef !== null && byBranch.taskRef !== task.ref) {
    return {
      kind: "refuse",
      decision: refuse(
        "WORKSPACE_ATTACH_INVALID",
        `branch ${task.branch} belongs to ${byBranch.taskRef}, not ${task.ref}`,
        "verify the task branch or detach the other task first",
      ),
    };
  }
  return byBranch;
}

interface ResolvedTarget {
  readonly path: string;
  readonly branch: string;
  readonly exists?: boolean;
  readonly checkedOutAt?: string | null;
}

function resolveTarget(
  context: WorkspacePolicyContext,
): ResolvedTarget {
  const slug = worktreeSlug(context.task);
  const directory = context.worktreeDir ?? DEFAULT_WORKTREE_DIR;
  const path =
    context.target?.path ??
    (isAbsoluteDirectory(directory)
      ? joinPath(directory, slug)
      : joinPath(context.currentCheckout, directory, slug));
  // A task whose `branch` is the integration branch has no dedicated feature
  // branch (older `task.py start` recorded `main`). Creating a worktree on the
  // integration branch is impossible — it is already checked out — so fall
  // back to the conventional per-task branch.
  const taskBranch = context.task.branch ?? null;
  let featureBranch = `phronia/${slug}`;
  if (
    taskBranch !== null &&
    isDedicatedFeatureBranch(taskBranch, context.integrationBranch)
  ) {
    featureBranch = taskBranch;
  }
  const branch = context.target?.branch ?? featureBranch;
  return {
    path,
    branch,
    exists: context.target?.exists,
    checkedOutAt: context.target?.checkedOutAt,
  };
}

function createOrRefuse(
  policy: "auto" | "always" | "never",
  context: WorkspacePolicyContext,
  target: ResolvedTarget,
  reason: string,
): WorkspaceDecision {
  if (policy !== "never") {
    const code = reason.startsWith("stale-dirty")
      ? "WORKSPACE_CLAIM_STALE_DIRTY"
      : reason.startsWith("stale-owned")
        ? "WORKSPACE_CLAIM_STALE_OWNED"
        : "WORKSPACE_CLAIM_BUSY";
    return createDecision(context, target, reason, code);
  }
  if (reason.startsWith("stale-dirty")) {
    return refuse(
      "WORKSPACE_CLAIM_STALE_DIRTY",
      reason,
      "use a worktree or ask the previous owner to commit/stash; do not reclaim the checkout",
    );
  }
  if (reason.startsWith("stale-owned")) {
    return refuse(
      "WORKSPACE_CLAIM_STALE_OWNED",
      reason,
      "keep the worktree, or run `phronia task workspace reclaim` explicitly",
    );
  }
  return refuse(
    "WORKSPACE_CLAIM_BUSY",
    reason,
    "wait for the owner, use a worktree, or enable parallel.worktree",
  );
}

function createDecision(
  context: WorkspacePolicyContext,
  target: ResolvedTarget,
  reason: string,
  code?: string,
): WorkspaceDecision {
  const decision: WorkspaceDecision = {
    kind: "create",
    path: target.path,
    branch: target.branch,
    base: context.integrationBranch === "" ? "main" : context.integrationBranch,
    reason,
  };
  if (code !== undefined) {
    return { ...decision, code };
  }
  return decision;
}

function describeClaim(claim: WorkspaceClaim): string {
  if (claim.taskRef !== null) return claim.taskRef;
  return claim.ownerRef;
}

function refuse(code: string, reason: string, next: string): WorkspaceDecision {
  return { kind: "refuse", code, reason, next };
}

/**
 * Directory-safe slug. Path-length hashing belongs to the runtime adapter; this
 * helper only guarantees a deterministic, conservative name.
 */
export function worktreeSlug(task: {
  readonly ref: string;
  readonly id?: string;
}): string {
  const source =
    task.id !== undefined && task.id !== ""
      ? task.id
      : (task.ref.split("/").filter((part) => part !== "").at(-1) ?? "task");
  const sanitized = source
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return sanitized === "" ? "task" : sanitized;
}

function isAbsoluteDirectory(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

function joinPath(root: string, ...parts: readonly string[]): string {
  const normalizedRoot = root.replace(/\\/g, "/");
  const base = normalizedRoot.replace(/\/+$/, "");
  const tail = parts
    .map((part) => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter((part) => part !== "");
  if (base === "") {
    // Preserve the POSIX root when the caller passed "/".
    return normalizedRoot.startsWith("/")
      ? `/${tail.join("/")}`
      : tail.join("/");
  }
  return [base, ...tail].join("/");
}
