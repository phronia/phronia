/**
 * Pure spec-delta policy.
 *
 * No IO, no printing, no `process.cwd()`. The CLI/service layer reads files
 * and git; this module only parses intent, validates targets lexically, and
 * compares sets.
 */

import path from "node:path";
import type {
  SpecDelta,
  SpecSyncState,
  SpecSyncTaskFacts,
  SpecTargetIssue,
} from "./types.js";

const SPEC_PREFIX = ".phronia/spec/";

type Section = "targetFiles" | "intent" | "rationale" | "verification";

const HEADING_ALIASES: Readonly<Record<string, Section>> = {
  "target files": "targetFiles",
  "target file": "targetFiles",
  "intended changes": "intent",
  "intent": "intent",
  "changes": "intent",
  "rationale": "rationale",
  "why": "rationale",
  "verification": "verification",
  "verify": "verification",
  "validation": "verification",
};

/**
 * Parse a `spec-delta.md` document.
 *
 * Tolerates `##`/`###` headings, `-`/`*`/`+`/numbered bullets, and backticks
 * around paths. Unknown sections are ignored; missing sections yield empty
 * lists rather than throwing, so the validator (not the parser) decides what
 * is usable.
 */
export function parseSpecDelta(markdown: string): SpecDelta {
  const sections: Record<Section, string[]> = {
    targetFiles: [],
    intent: [],
    rationale: [],
    verification: [],
  };

  let current: Section | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = headingText(line);
    if (heading !== null) {
      current = HEADING_ALIASES[heading] ?? null;
      continue;
    }
    if (current === null) continue;
    const bullet = bulletText(line);
    if (bullet === null) continue;
    const value = cleanValue(bullet);
    if (value !== "") sections[current].push(value);
  }

  return {
    targetFiles: unique(sections.targetFiles),
    intent: sections.intent,
    rationale: sections.rationale,
    verification: sections.verification,
  };
}

/**
 * Validate delta targets lexically: repo-relative, no `..`, and strictly under
 * `.phronia/spec/`. `root` is returned in the result so callers can render a
 * repo-scoped message without this function reading the filesystem.
 */
export function validateSpecTargets(
  targets: readonly string[],
  root: string,
): { readonly ok: boolean; readonly root: string; readonly invalid: readonly SpecTargetIssue[] } {
  const invalid: SpecTargetIssue[] = [];
  for (const target of targets) {
    const reason = invalidTargetReason(target);
    if (reason !== null) invalid.push({ target, reason });
  }
  return { ok: invalid.length === 0, root, invalid };
}

function invalidTargetReason(target: string): string | null {
  const value = target.trim();
  if (value === "") return "target is empty";
  const normalized = normalizePath(value);
  if (normalized === "") return "target is empty";
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) {
    return "target must be repo-relative, not absolute";
  }
  if (normalized.split("/").includes("..")) {
    return "target may not contain '..'";
  }
  if (!normalized.startsWith(SPEC_PREFIX) || normalized === SPEC_PREFIX.slice(0, -1)) {
    return `target must start with ${SPEC_PREFIX}`;
  }
  return null;
}

/** A delta may be applied only after the code landed. */
export function canSync(facts: SpecSyncTaskFacts): boolean {
  if (!facts.hasDelta) return false;
  return integrationOutcome(facts.meta) === "landed";
}

/**
 * Compare declared targets with the spec files actually changed in the main
 * checkout. `missing` targets did not change; `extra` changed spec files were
 * not declared by the delta.
 */
export function verifyChangedTargets(
  targets: readonly string[],
  changedFiles: readonly string[],
): { readonly missing: readonly string[]; readonly extra: readonly string[] } {
  const targetSet = new Set(targets.map(normalizePath).filter((item) => item !== ""));
  const changedSet = new Set(
    changedFiles.map(normalizePath).filter((item) => item !== ""),
  );
  return {
    missing: [...targetSet].filter((target) => !changedSet.has(target)),
    extra: [...changedSet].filter((file) => !targetSet.has(file)),
  };
}

/** A spec-only task runs in the control plane and never enters a wave. */
export function isSpecOnly(task: { readonly meta?: unknown }): boolean {
  return metaString(task.meta, "kind") === "spec";
}

/** Read `meta.spec_sync.status` with a safe default. */
export function readSpecSyncState(meta: unknown): SpecSyncState {
  const specSync = metaObject(meta, "spec_sync");
  const status = specSync?.status;
  return status === "none" ||
    status === "pending" ||
    status === "synced" ||
    status === "failed"
    ? status
    : "none";
}

/**
 * Runtime-state projection: `spec-delta.md` makes a task pending until its
 * sync is recorded; no delta is `none`, and a failed sync reads as pending so
 * the operator still sees work outstanding.
 */
export function resolveSpecDisplayState(input: {
  readonly hasDelta: boolean;
  readonly syncState: SpecSyncState;
}): "none" | "pending" | "synced" {
  if (input.syncState === "synced") return "synced";
  if (input.hasDelta || input.syncState === "pending" || input.syncState === "failed") {
    return "pending";
  }
  return "none";
}

function integrationOutcome(meta: Readonly<Record<string, unknown>>): string | null {
  const integration = meta.integration;
  if (typeof integration !== "object" || integration === null || Array.isArray(integration)) {
    return null;
  }
  const outcome = (integration as Record<string, unknown>).outcome;
  return typeof outcome === "string" ? outcome : null;
}

function metaObject(meta: unknown, key: string): Record<string, unknown> | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metaString(meta: unknown, key: string): string | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function headingText(line: string): string | null {
  const match = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (match === null) return null;
  const text = (match[1] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return text === "" ? null : text;
}

function bulletText(line: string): string | null {
  const match = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
  return match === null ? null : (match[1] ?? "");
}

function cleanValue(value: string): string {
  return value.replace(/`/g, "").trim();
}

function normalizePath(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
