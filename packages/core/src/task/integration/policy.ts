/**
 * Integration policy: mode resolution and conflict classification.
 *
 * Both functions are pure and return plain data plus diagnostics. They never
 * decide to "fix" a conflict; the best they can do is route it (design.md §8).
 */

import { diagnostic } from "../../state/diagnostics.js";
import type { Diagnostic } from "../../state/diagnostics.js";
import {
  pathMatchesPattern,
  pathWithinFootprint,
} from "../parallel/footprint.js";
import { DEFAULT_ALWAYS_SERIAL } from "../parallel/planner.js";
import type {
  ConflictClassification,
  ConflictInput,
  ConflictKind,
  IntegrationMode,
  IntegrationModeContext,
  IntegrationModeResolution,
  IntegrationOutcome,
  ResolvedMode,
} from "./types.js";

export const DEFAULT_GENERATED_PATTERNS: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "**/dist/**",
  "**/generated/**",
];

export const DEFAULT_MECHANICAL_MAX_FILES = 5;

/**
 * Resolve the integration mode using the fixed priority:
 * task override -> `--mode` -> project config -> auto detection.
 */
export function resolveIntegrationMode(
  context: IntegrationModeContext,
): IntegrationModeResolution {
  const diagnostics: Diagnostic[] = [];
  const localAvailable = context.localAvailable !== false;
  const hasOrigin = context.hasOrigin;
  const remoteAvailable =
    (context.remoteAvailable ?? hasOrigin) && hasOrigin && context.taskUsesMain !== true;
  const alternatives: ResolvedMode[] = [];
  if (localAvailable) alternatives.push("local");
  if (remoteAvailable) alternatives.push("remote");

  let invalid = false;
  const explicit = firstExplicitMode(context);
  let mode: ResolvedMode;
  let source: IntegrationModeResolution["source"];
  let detail: string;

  if (explicit !== null) {
    source = explicit.source;
    detail = explicit.detail;
    const rejected = rejectionReason(explicit.mode, context, hasOrigin);
    if (rejected !== null) {
      invalid = true;
      diagnostics.push(
        diagnostic(
          rejected.code,
          "error",
          rejected.message,
          { details: { requested: explicit.mode, next: rejected.next } },
        ),
      );
      // Fall back to what is actually possible so the caller can still make
      // progress, but mark the resolution invalid.
      const fallback = autoDetect(context, hasOrigin);
      mode = fallback.mode;
      detail = `${rejected.message}; ${fallback.detail}`;
    } else {
      mode = explicit.mode;
    }
  } else {
    const detected = autoDetect(context, hasOrigin);
    mode = detected.mode;
    source = "auto";
    detail = detected.detail;
  }

  if (context.requiresReviewOrCi === true && mode === "remote") {
    detail = `${detail}, project requires review/CI`;
  }

  const confirm = context.confirm ?? "auto";
  const recorded =
    context.modeRecorded ?? isConcreteMode(context.taskMode ?? null);
  const shouldAsk = decideAsk(confirm, source, recorded, alternatives.length, invalid);

  return {
    mode,
    source,
    reason: `mode=${mode} (${detail}; confirm=${confirm})`,
    shouldAsk,
    alternatives,
    invalid,
    diagnostics,
  };
}

function firstExplicitMode(
  context: IntegrationModeContext,
): {
  readonly mode: ResolvedMode;
  readonly source: IntegrationModeResolution["source"];
  readonly detail: string;
} | null {
  if (isConcreteMode(context.taskMode ?? null)) {
    return {
      mode: context.taskMode as ResolvedMode,
      source: "task",
      detail: "recorded on the task",
    };
  }
  if (isConcreteMode(context.cliMode ?? null)) {
    return {
      mode: context.cliMode as ResolvedMode,
      source: "cli",
      detail: "from --mode",
    };
  }
  if (isConcreteMode(context.projectMode ?? null)) {
    return {
      mode: context.projectMode as ResolvedMode,
      source: "project",
      detail: "from parallel.integration.mode",
    };
  }
  return null;
}

function isConcreteMode(value: IntegrationMode | null): boolean {
  return value === "local" || value === "remote";
}

function rejectionReason(
  mode: ResolvedMode,
  context: IntegrationModeContext,
  hasOrigin: boolean,
): { code: string; message: string; next: string } | null {
  if (mode === "remote" && context.taskUsesMain === true) {
    return {
      code: "INTEGRATE_MODE_INVALID",
      message: "a task using the main checkout cannot be integrated remotely",
      next: "use --mode local, or move the task to a worktree first",
    };
  }
  if (mode === "remote" && !hasOrigin) {
    return {
      code: "INTEGRATE_REMOTE_UNAVAILABLE",
      message: "remote integration requested but the repository has no origin",
      next: "use --mode local",
    };
  }
  if (mode === "local" && context.localAvailable === false) {
    return {
      code: "INTEGRATE_MODE_INVALID",
      message: "local integration is not available for this task",
      next: "use --mode remote",
    };
  }
  return null;
}

function autoDetect(
  context: IntegrationModeContext,
  hasOrigin: boolean,
): { readonly mode: ResolvedMode; readonly detail: string } {
  if (context.taskUsesMain === true) {
    return { mode: "local", detail: "task uses the main checkout" };
  }
  if (!hasOrigin) {
    return { mode: "local", detail: "no origin" };
  }
  if (context.remoteAvailable === false) {
    return { mode: "local", detail: "remote integration is unavailable" };
  }
  return {
    mode: "remote",
    detail: context.forgeCliAvailable
      ? "origin available, forge CLI available"
      : "origin available, no forge CLI (push only)",
  };
}

function decideAsk(
  confirm: "auto" | "always" | "never",
  source: IntegrationModeResolution["source"],
  recorded: boolean,
  alternativeCount: number,
  invalid: boolean,
): boolean {
  if (invalid || recorded) return false;
  if (confirm === "never") return false;
  if (confirm === "always") return source === "auto";
  return source === "auto" && alternativeCount > 1;
}

/**
 * Map a conflict classification to the task-level outcome written into
 * `meta.integration.outcome`.
 *
 * A verification failure is `blocked` on a normal retry (INT-02) but
 * `needs_human` when `--handoff` is requested (INT-03): either way the base
 * branch must not move.
 */
export function outcomeForConflict(
  kind: ConflictKind,
  options: { readonly handoff?: boolean } = {},
): IntegrationOutcome {
  switch (kind) {
    case "semantic":
      return options.handoff === true ? "needs_human" : "blocked";
    case "generated":
    case "mechanical":
    case "race":
      return "blocked";
    case "duplicate":
    case "needs_human":
      return "needs_human";
  }
}

/**
 * Classify a rebase/verify failure into the conflict taxonomy from §8.1.
 *
 * The order matters: a clean rebase with a failing verification is semantic,
 * an all-generated conflict set is generated even if paths are add/add, and
 * only conflicts fully inside the task footprint are mechanical.
 */
export function classifyConflict(input: ConflictInput): ConflictClassification {
  const files = normalizeFiles(input.conflictFiles ?? []);
  const addAdd = normalizeFiles(input.addAddFiles ?? []);
  const generated = input.generatedPatterns ?? DEFAULT_GENERATED_PATTERNS;
  const alwaysSerial = input.alwaysSerialPatterns ?? DEFAULT_ALWAYS_SERIAL;
  const mechanicalMax = resolveMechanicalMax(input.mechanicalMaxFiles);

  if (files.length === 0 && input.verificationFailed === true) {
    return result(
      "semantic",
      [],
      "clean rebase, but verification failed on the rebased tree",
      "inspect the failing verification and decide the intended behavior; run with --handoff for a report",
      [semanticDiagnostic()],
    );
  }

  if (files.length === 0 && input.baseMoved === true) {
    return result(
      "race",
      [],
      "the integration branch moved while landing",
      "retry integrate; if the branch keeps moving, queue the task",
      [raceDiagnostic()],
    );
  }

  if (files.length > 0) {
    if (files.every((file) => matchesAny(file, generated))) {
      return result(
        "generated",
        files,
        "all conflicting files are generated artifacts",
        input.regenerateConfigured === true
          ? "regenerate the artifacts, then retry integrate"
          : "configure parallel.conflicts.regenerate or resolve the generated files manually, then retry",
        [conflictDiagnostic("generated", files, "warn")],
      );
    }

    if (addAdd.length > 0) {
      return result(
        "duplicate",
        unique([...files, ...addAdd]),
        "add/add conflict: both tasks added the same path",
        "choose one implementation, remove the duplicate, commit in the task worktree, then retry",
        [conflictDiagnostic("duplicate", files, "warn")],
      );
    }

    const serialPattern = files
      .map((file) => firstMatch(file, alwaysSerial))
      .find((match) => match !== null);
    if (serialPattern !== undefined) {
      return result(
        "needs_human",
        files,
        `conflict touches an always-serial shared file (${serialPattern})`,
        "decide the intended shared-file content manually; do not auto-resolve",
        [conflictDiagnostic("needs_human", files, "warn")],
      );
    }

    const footprint = input.footprint;
    const insideFootprint =
      footprint !== undefined &&
      files.every((file) => pathWithinFootprint(file, footprint));
    if (insideFootprint && files.length <= mechanicalMax) {
      return result(
        "mechanical",
        files,
        `textual conflicts are inside the task footprint (${files.length} file(s))`,
        "resolve the conflicts inside the task worktree, commit, then retry integrate",
        [conflictDiagnostic("mechanical", files, "info")],
      );
    }

    return result(
      "needs_human",
      files,
      insideFootprint
        ? `too many conflicting files (${files.length} > ${mechanicalMax}) to resolve mechanically`
        : "conflicts include paths outside the task footprint or a shared contract",
      "review the conflict manually and update the task contract before retrying",
      [conflictDiagnostic("needs_human", files, "warn")],
    );
  }

  if (input.baseMoved === true) {
    return result(
      "race",
      [],
      "the integration branch moved while landing",
      "retry integrate; if the branch keeps moving, queue the task",
      [raceDiagnostic()],
    );
  }

  return result(
    "needs_human",
    [],
    "no conflict signal was provided",
    "inspect the integration log and rerun with explicit conflict data",
    [conflictDiagnostic("needs_human", [], "warn")],
  );
}

function result(
  kind: ConflictClassification["kind"],
  files: readonly string[],
  reason: string,
  next: string,
  diagnostics: readonly Diagnostic[],
): ConflictClassification {
  return { kind, files, reason, next, diagnostics };
}

function conflictDiagnostic(
  kind: ConflictClassification["kind"],
  files: readonly string[],
  severity: "info" | "warn",
): Diagnostic {
  return diagnostic("INTEGRATE_CONFLICT", severity, `conflict classified as ${kind}`, {
    details: { kind, files: [...files] },
  });
}

function semanticDiagnostic(): Diagnostic {
  return diagnostic(
    "INTEGRATE_VERIFY_FAILED",
    "error",
    "verification failed after a clean rebase (semantic conflict)",
    { details: { next: "inspect the failing command output" } },
  );
}

function raceDiagnostic(): Diagnostic {
  return diagnostic(
    "INTEGRATE_BASE_MOVED",
    "warn",
    "integration branch moved during landing",
    { details: { next: "retry integrate" } },
  );
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pathMatchesPattern(pattern, file));
}

function firstMatch(
  file: string,
  patterns: readonly string[],
): string | null {
  for (const pattern of patterns) {
    if (pathMatchesPattern(pattern, file)) return pattern;
  }
  return null;
}

function normalizeFiles(files: readonly string[]): readonly string[] {
  return unique(files.map((file) => file.trim()).filter((file) => file !== ""));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function resolveMechanicalMax(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MECHANICAL_MAX_FILES;
  }
  return Math.floor(value);
}
