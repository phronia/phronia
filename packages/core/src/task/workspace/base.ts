/**
 * Worktree base-ref resolution (pure).
 *
 * One resolver answers "which commit should a new worktree fork from?" for
 * `workspace ensure`, `workspace prepare`, and `worktree add`. The caller
 * supplies git facts through injected callbacks; this module performs no IO.
 *
 * Precedence is a public contract:
 *   --base -> task.base_branch -> parallel.integration.branch -> mode-selected
 *   integration ref (remote or local) -> explicit HEAD.
 *
 * There is deliberately no "main" fallback. When nothing resolves, the caller
 * gets a refusal with an executable next step instead of a silent guess.
 */

import {
  diagnostic,
  type Diagnostic,
} from "../../state/diagnostics.js";

export type BaseRefMode = "auto" | "local" | "remote";
export type BaseRefConfirm = "auto" | "always" | "never";
export type BaseRefFreshness = "local" | "fetched" | "unverified";

export type BaseRefSource =
  | "cli"
  | "task"
  | "config"
  | "remote-head"
  | "local-integration"
  | "head";

export interface BaseRefComparison {
  /** Commits reachable from the base but not from the local integration ref. */
  readonly ahead: number;
  /** Commits reachable from the local integration ref but not from the base. */
  readonly behind: number;
}

export interface BaseRefFacts {
  readonly cliBase?: string | null;
  readonly taskBaseBranch?: string | null;
  readonly configBranch?: string | null;
  readonly mode: BaseRefMode;
  readonly confirm: BaseRefConfirm;
  /** `origin/HEAD` symbolic target, already normalized (e.g. `origin/develop`). */
  readonly remoteHead?: string | null;
  readonly remoteMain?: string | null;
  readonly remoteMaster?: string | null;
  readonly localMain?: string | null;
  readonly localMaster?: string | null;
  /** The local ref a remote base is compared against. */
  readonly localIntegration?: string | null;
  /** Resolve a ref to a commit; null when the ref does not exist. */
  readonly resolveRef: (ref: string) => string | null;
  /** Ahead/behind for the chosen base; null when it cannot be computed. */
  readonly compare?: (
    base: string,
    localIntegration: string,
  ) => BaseRefComparison | null;
  /** Set by the caller after an explicit fetch. */
  readonly freshness?: BaseRefFreshness;
  /** Diagnostic codes to add before the resolver's own diagnostics. */
  readonly diagnostics?: readonly Diagnostic[];
}

export interface ResolvedBaseRef {
  readonly ok: true;
  readonly ref: string;
  readonly commit: string;
  readonly source: BaseRefSource;
  readonly remote: boolean;
  readonly localIntegration: string | null;
  readonly behind: number | null;
  readonly ahead: number | null;
  readonly freshness: BaseRefFreshness;
  readonly shouldAsk: boolean;
  readonly alternatives: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface UnresolvedBaseRef {
  readonly ok: false;
  readonly code:
    | "WORKTREE_BASE_UNRESOLVED"
    | "WORKTREE_BASE_REMOTE_UNAVAILABLE"
    | "WORKTREE_BASE_INVALID";
  readonly reason: string;
  readonly next: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type BaseRefResolution = ResolvedBaseRef | UnresolvedBaseRef;

interface Candidate {
  readonly ref: string;
  readonly source: BaseRefSource;
}

export function resolveWorktreeBase(facts: BaseRefFacts): BaseRefResolution {
  const diagnostics: Diagnostic[] = [...(facts.diagnostics ?? [])];
  const remoteChain = firstNonEmpty([
    facts.remoteHead,
    facts.remoteMain,
    facts.remoteMaster,
  ]);
  const localChain = firstNonEmpty([facts.localMain, facts.localMaster]);
  const alternatives = collectAlternatives(facts, remoteChain, localChain);

  const explicit = explicitCandidate(facts, diagnostics);
  if (explicit !== null && isUnresolved(explicit)) return explicit;
  if (explicit !== null) {
    return finish(facts, explicit, alternatives, diagnostics);
  }

  const chain = modeChain(facts.mode, remoteChain, localChain);
  if (chain === "remote-unavailable") {
    diagnostics.push(
      diagnostic(
        "WORKTREE_BASE_REMOTE_UNAVAILABLE",
        "error",
        "parallel.base.mode is remote but the repository has no resolvable origin branch",
        { details: { mode: facts.mode } },
      ),
    );
    return {
      ok: false,
      code: "WORKTREE_BASE_REMOTE_UNAVAILABLE",
      reason:
        "remote base requested but no origin/HEAD, origin/main, or origin/master exists",
      next: "pass --base <ref>, or set parallel.base.mode to auto/local",
      diagnostics,
    };
  }

  for (const candidate of chain) {
    const commit = facts.resolveRef(candidate.ref);
    if (commit !== null) {
      return finish(facts, candidate, alternatives, diagnostics, commit);
    }
  }

  diagnostics.push(
    diagnostic(
      "WORKTREE_BASE_UNRESOLVED",
      "error",
      "no worktree base ref could be resolved",
      {
        details: {
          mode: facts.mode,
          remoteChain: remoteChain.map((entry) => entry.ref),
          localChain: localChain.map((entry) => entry.ref),
        },
      },
    ),
  );
  return {
    ok: false,
    code: "WORKTREE_BASE_UNRESOLVED",
    reason: "no --base, task.base_branch, integration branch, or origin ref resolved",
    next: "pass --base <ref>, or configure parallel.integration.branch",
    diagnostics,
  };
}

function explicitCandidate(
  facts: BaseRefFacts,
  diagnostics: Diagnostic[],
): Candidate | UnresolvedBaseRef | null {
  const steps: readonly {
    readonly ref: string | null | undefined;
    readonly source: Exclude<BaseRefSource, "remote-head" | "local-integration">;
    readonly label: string;
  }[] = [
    { ref: facts.cliBase, source: "cli", label: "--base" },
    { ref: facts.taskBaseBranch, source: "task", label: "task.base_branch" },
    { ref: facts.configBranch, source: "config", label: "parallel.integration.branch" },
  ];

  for (const step of steps) {
    const raw = step.ref?.trim() ?? "";
    if (raw === "") continue;
    const ref = normalizeRef(raw);
    const commit = facts.resolveRef(ref);
    if (commit === null) {
      diagnostics.push(
        diagnostic(
          "WORKTREE_BASE_INVALID",
          "error",
          `${step.label} names a ref that does not exist: ${raw}`,
          { details: { ref: raw, source: step.source } },
        ),
      );
      return {
        ok: false,
        code: "WORKTREE_BASE_INVALID",
        reason: `${step.label} names a ref that does not exist: ${raw}`,
        next: "fix the ref or remove the override",
        diagnostics,
      };
    }
    return { ref, source: isHead(ref) ? "head" : step.source };
  }
  return null;
}

function isUnresolved(
  value: Candidate | UnresolvedBaseRef,
): value is UnresolvedBaseRef {
  return "ok" in value && value.ok === false;
}

function modeChain(
  mode: BaseRefMode,
  remoteChain: readonly Candidate[],
  localChain: readonly Candidate[],
): readonly Candidate[] | "remote-unavailable" {
  if (mode === "remote") {
    return remoteChain.length === 0 ? "remote-unavailable" : remoteChain;
  }
  if (mode === "local") {
    return localChain;
  }
  return remoteChain.length > 0 ? remoteChain : localChain;
}

function finish(
  facts: BaseRefFacts,
  candidate: Candidate,
  alternatives: readonly string[],
  diagnostics: Diagnostic[],
  resolvedCommit?: string,
): BaseRefResolution {
  const commit = resolvedCommit ?? facts.resolveRef(candidate.ref) ?? undefined;
  if (commit === undefined) {
    diagnostics.push(
      diagnostic(
        "WORKTREE_BASE_INVALID",
        "error",
        `base ref does not resolve: ${candidate.ref}`,
        { details: { ref: candidate.ref } },
      ),
    );
    return {
      ok: false,
      code: "WORKTREE_BASE_INVALID",
      reason: `base ref does not resolve: ${candidate.ref}`,
      next: "fix the ref or remove the override",
      diagnostics,
    };
  }

  const remote = isRemoteRef(candidate.ref);
  const freshness: BaseRefFreshness = remote
    ? (facts.freshness ?? "unverified")
    : "local";
  if (remote && freshness === "unverified") {
    diagnostics.push(
      diagnostic(
        "WORKTREE_BASE_UNVERIFIED",
        "warn",
        `remote base ${candidate.ref} was not fetched; it may be behind the remote`,
        { details: { ref: candidate.ref } },
      ),
    );
  }

  let behind: number | null = null;
  let ahead: number | null = null;
  const local = facts.localIntegration ?? null;
  if (local !== null && local !== "" && facts.compare !== undefined) {
    const comparison = facts.compare(candidate.ref, local);
    if (comparison !== null) {
      behind = comparison.behind;
      ahead = comparison.ahead;
    }
  }

  const shouldAsk =
    facts.confirm === "always" ||
    (facts.confirm === "auto" && remote);

  return {
    ok: true,
    ref: candidate.ref,
    commit,
    source: candidate.source,
    remote,
    localIntegration: local,
    behind,
    ahead,
    freshness,
    shouldAsk,
    alternatives,
    diagnostics,
  };
}

function collectAlternatives(
  facts: BaseRefFacts,
  remoteChain: readonly Candidate[],
  localChain: readonly Candidate[],
): readonly string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (ref: string | null | undefined): void => {
    const raw = ref?.trim() ?? "";
    if (raw === "") return;
    const normalized = normalizeRef(raw);
    if (seen.has(normalized)) return;
    if (facts.resolveRef(normalized) === null) return;
    seen.add(normalized);
    values.push(normalized);
  };
  add(facts.cliBase);
  add(facts.taskBaseBranch);
  add(facts.configBranch);
  for (const candidate of [...remoteChain, ...localChain]) add(candidate.ref);
  add("HEAD");
  return values;
}

function firstNonEmpty(
  values: readonly (string | null | undefined)[],
): Candidate[] {
  const result: Candidate[] = [];
  for (const value of values) {
    const raw = value?.trim() ?? "";
    if (raw === "") continue;
    result.push({
      ref: normalizeRef(raw),
      source: raw.startsWith("origin/") ? "remote-head" : "local-integration",
    });
  }
  return result;
}

export function normalizeRef(value: string): string {
  let ref = value.trim().replace(/\\/g, "/");
  while (ref.startsWith("./")) ref = ref.slice(2);
  if (ref.startsWith("refs/heads/")) ref = ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) ref = ref.slice("refs/remotes/".length);
  return ref;
}

export function isRemoteRef(ref: string): boolean {
  const normalized = normalizeRef(ref);
  return normalized.startsWith("origin/") || normalized.startsWith("refs/remotes/");
}

function isHead(ref: string): boolean {
  return normalizeRef(ref) === "HEAD";
}
