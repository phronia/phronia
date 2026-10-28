/**
 * Footprint normalization and conservative overlap detection.
 *
 * A footprint answers "which paths may this task change?". The rules are
 * deliberately conservative: anything we cannot prove disjoint is treated as
 * overlapping, because a false "parallel" is far more expensive than a false
 * "serial". See design.md §5.
 */

import type {
  Footprint,
  FootprintSources,
  OverlapResult,
  ParallelMeta,
  TaskFootprintInput,
} from "./types.js";

const UNKNOWN_FOOTPRINT: Footprint = { raw: [], kind: "unknown" };

const UNKNOWN_OVERLAP: OverlapResult = {
  overlap: true,
  kind: "unknown",
  a: "",
  b: "",
  path: "",
  reason: "overlap: unknown_footprint",
};

const NO_OVERLAP: OverlapResult = {
  overlap: false,
  kind: "none",
  a: "",
  b: "",
  path: "",
  reason: "",
};

/**
 * Normalize a task footprint using the documented priority:
 * `meta.parallel.touches` -> `relatedFiles` -> `scope` mapping ->
 * `package` mapping -> unknown.
 */
export function normalizeFootprint(
  input: TaskFootprintInput,
  sources: FootprintSources = {},
): Footprint {
  const parallel = readParallelMeta(input.meta);
  if (parallel.touches.length > 0) {
    return { raw: normalizePatternList(parallel.touches), kind: "declared" };
  }

  const related = normalizePatternList(input.relatedFiles ?? []);
  if (related.length > 0) {
    return { raw: related, kind: "related" };
  }

  const scoped = scopePatterns(input.scope, sources);
  if (scoped.length > 0) {
    return { raw: scoped, kind: "declared" };
  }

  const packagePattern = packageFootprint(input.package, sources);
  if (packagePattern !== null) {
    return { raw: [packagePattern], kind: "package" };
  }

  return UNKNOWN_FOOTPRINT;
}

/**
 * Read the subset of `meta.parallel` the planner understands. Anything
 * malformed is ignored rather than guessed — the caller still gets a usable
 * (usually unknown) footprint.
 */
export function readParallelMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): ParallelMeta {
  const parallel = isRecord(meta?.parallel) ? meta.parallel : undefined;
  const worktree = parallel?.worktree;
  return {
    touches: stringArray(parallel?.touches),
    dependsOn: stringArray(parallel?.depends_on ?? parallel?.dependsOn),
    exclusive: parallel?.exclusive === true,
    worktree:
      worktree === "auto" || worktree === "always" || worktree === "never"
        ? worktree
        : null,
    allowUnknownFootprint:
      parallel?.allow_unknown_footprint === true ||
      parallel?.allowUnknownFootprint === true,
  };
}

/** Normalize and de-duplicate a list of paths/globs. */
export function normalizePatternList(
  patterns: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const normalized = normalizePathPattern(pattern);
    if (normalized === "") continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * Normalize one path or glob for comparison: forward slashes, collapsed
 * separators, no leading `./`, no trailing slash (except root).
 */
export function normalizePathPattern(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Conservative overlap test between two footprints.
 *
 * Overlap is reported when:
 * - either side is unknown;
 * - normalized literal paths are equal (case-insensitive);
 * - one path is a directory prefix of the other;
 * - a `**` glob covers the other path;
 * - two package-level footprints refer to the same package.
 *
 * Different file-level literals never overlap.
 */
export function footprintOverlap(a: Footprint, b: Footprint): OverlapResult {
  const aRaw = meaningfulPatterns(a.raw);
  const bRaw = meaningfulPatterns(b.raw);
  if (a.kind === "unknown" || b.kind === "unknown" || aRaw.length === 0 || bRaw.length === 0) {
    return UNKNOWN_OVERLAP;
  }

  const aPackage = a.kind === "package";
  const bPackage = b.kind === "package";

  for (const left of aRaw) {
    const leftLower = left.toLowerCase();
    for (const right of bRaw) {
      const rightLower = right.toLowerCase();

      if (aPackage && bPackage && leftLower === rightLower) {
        return result("package", left, right);
      }
      if (leftLower === rightLower) {
        return result("equal", left, right);
      }
      if (isDirectoryPrefix(leftLower, rightLower)) {
        return result("prefix", left, right);
      }
      if (isDirectoryPrefix(rightLower, leftLower)) {
        return result("prefix", right, left);
      }
      if (leftLower.includes("**") && globMatches(leftLower, rightLower)) {
        return result("glob", left, right);
      }
      if (rightLower.includes("**") && globMatches(rightLower, leftLower)) {
        return result("glob", right, left);
      }
    }
  }
  return NO_OVERLAP;
}

/** Boolean convenience wrapper used by the planner. */
export function footprintsOverlap(a: Footprint, b: Footprint): boolean {
  return footprintOverlap(a, b).overlap;
}

/** Whether a concrete repo-relative path is inside a footprint. */
export function pathWithinFootprint(
  file: string,
  footprint: Footprint,
): boolean {
  if (footprint.kind === "unknown" || footprint.raw.length === 0) return false;
  const candidate = normalizePathPattern(file);
  if (candidate === "") return false;
  const candidateLower = candidate.toLowerCase();
  return footprint.raw.some((pattern) => {
    if (pathMatchesPattern(pattern, candidate)) return true;
    // A literal directory footprint also covers its children.
    if (pattern.includes("*")) return false;
    return isDirectoryPrefix(
      normalizePathPattern(pattern).toLowerCase(),
      candidateLower,
    );
  });
}

/**
 * Match one normalized path or glob against a concrete path.
 *
 * Supports the subset the design relies on: literals, single `*` segments,
 * leading `**\/`, trailing `/**`, and a conservative middle `**`.
 */
export function pathMatchesPattern(
  pattern: string,
  candidate: string,
): boolean {
  const pat = normalizePathPattern(pattern).toLowerCase();
  const value = normalizePathPattern(candidate).toLowerCase();
  if (pat === "" || value === "") return false;
  return globMatches(pat, value);
}

function result(
  kind: Exclude<OverlapResult["kind"], "none" | "unknown">,
  path: string,
  other: string,
): OverlapResult {
  return {
    overlap: true,
    kind,
    a: path,
    b: other,
    path,
    reason: `overlap: ${path}`,
  };
}

function meaningfulPatterns(raw: readonly string[]): readonly string[] {
  return raw
    .filter((pattern): pattern is string => typeof pattern === "string")
    .map(normalizePathPattern)
    .filter((pattern) => pattern !== "");
}

function isDirectoryPrefix(prefix: string, candidate: string): boolean {
  if (prefix === "" || candidate === "") return false;
  if (candidate === prefix) return false;
  return candidate.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * Minimal glob matcher. A `**` segment matches zero or more path segments;
 * `*` matches within one segment. Anything unhandled falls back to a literal
 * comparison, which is the conservative choice.
 */
function globMatches(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true;

  if (pattern.startsWith("**/")) {
    const rest = pattern.slice(3);
    if (rest === "") return true;
    if (globMatches(rest, candidate)) return true;
    let index = candidate.indexOf("/");
    while (index !== -1) {
      const suffix = candidate.slice(index + 1);
      if (suffix !== "" && globMatches(rest, suffix)) return true;
      index = candidate.indexOf("/", index + 1);
    }
    return false;
  }

  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    if (base === "") return true;
    return candidate === base || candidate.startsWith(`${base}/`);
  }

  if (pattern.includes("**")) {
    // A middle `**` is matched conservatively: anything under the prefix
    // overlaps, even when a suffix pattern is present. A false negative here
    // would wrongly allow parallel work on shared paths.
    const index = pattern.indexOf("**");
    const prefix = pattern.slice(0, index).replace(/\/+$/, "");
    if (prefix === "") return true;
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }

  if (!pattern.includes("*")) return false;

  const segments = pattern.split("*");
  const escaped = segments.map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${escaped}$`).test(candidate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scopePatterns(
  scope: string | null | undefined,
  sources: FootprintSources,
): readonly string[] {
  if (typeof scope !== "string" || scope.trim() === "") return [];
  const mapped = sources.scopePaths?.[scope];
  if (mapped === undefined) return [];
  const patterns = typeof mapped === "string" ? [mapped] : mapped;
  return normalizePatternList(patterns);
}

function packageFootprint(
  pkg: string | null | undefined,
  sources: FootprintSources,
): string | null {
  if (typeof pkg !== "string" || pkg.trim() === "") return null;
  const mapped = sources.packagePaths?.[pkg];
  const directory =
    mapped ??
    (pkg.includes("/") ? pkg : `packages/${pkg}`);
  const normalized = normalizePathPattern(directory);
  if (normalized === "") return null;
  return `${normalized}/**`;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
