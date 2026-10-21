/**
 * Deterministic redaction for recorded harness payloads.
 *
 * Fixtures are committed, so they must never contain a real home directory,
 * absolute project path, session id, or email address. Redaction is
 * deterministic: the same session id always maps to the same alias, which
 * keeps fixtures diffable across recordings.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** Payload keys whose string values are identity, never content. */
const ID_KEYS = new Set([
  "session_id",
  "sessionId",
  "sessionID",
  "conversation_id",
  "conversationId",
  "conversationID",
  "TRELLIS_CONTEXT_ID",
  "PHRONIA_CONTEXT_ID",
]);

/** Path-valued identity keys: prefer a path replacement, alias as a last resort. */
const TRANSCRIPT_KEYS = new Set([
  "transcript_path",
  "transcriptPath",
  "transcript",
]);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DEFAULT_MAX_STRING_LENGTH = 2_000;

export interface RedactionOptions {
  /** Absolute project root to replace with `<PROJECT_ROOT>`. */
  projectRoot?: string;
  /** Home directory to replace with `<HOME>`. Defaults to the current user's. */
  homeDir?: string;
  /** Longest retained string value; longer values are truncated. */
  maxStringLength?: number;
  /** Extra literal replacements applied before the built-in rules. */
  replacements?: ReadonlyArray<readonly [string, string]>;
}

export interface RedactionResult<T> {
  value: T;
  replacements: number;
  aliases: Readonly<Record<string, string>>;
}

interface RedactionState {
  replacements: number;
  aliases: Record<string, string>;
  options: Required<Omit<RedactionOptions, "replacements">> & {
    replacements: ReadonlyArray<readonly [string, string]>;
  };
}

export function redact<T>(value: T, options: RedactionOptions = {}): RedactionResult<T> {
  const state: RedactionState = {
    replacements: 0,
    aliases: {},
    options: {
      projectRoot: normalizeDir(options.projectRoot),
      homeDir: normalizeDir(options.homeDir ?? homedir()),
      maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
      replacements: options.replacements ?? [],
    },
  };

  const redacted = walk(value, undefined, state) as T;
  return { value: redacted, replacements: state.replacements, aliases: state.aliases };
}

function normalizeDir(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function walk(value: unknown, key: string | undefined, state: RedactionState): unknown {
  if (typeof value === "string") {
    return redactString(value, key, state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, undefined, state));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = walk(childValue, childKey, state);
    }
    return result;
  }
  return value;
}

function redactString(value: string, key: string | undefined, state: RedactionState): string {
  if (key !== undefined && ID_KEYS.has(key) && value.length > 0) {
    return aliasFor(value, state);
  }

  let result = value;
  for (const [from, to] of state.options.replacements) {
    if (from.length > 0 && result.includes(from)) {
      result = result.split(from).join(to);
      state.replacements += 1;
    }
  }

  if (state.options.projectRoot && result.includes(state.options.projectRoot)) {
    result = result.split(state.options.projectRoot).join("<PROJECT_ROOT>");
    state.replacements += 1;
  }
  if (state.options.homeDir && result.includes(state.options.homeDir)) {
    result = result.split(state.options.homeDir).join("<HOME>");
    state.replacements += 1;
  }
  if (EMAIL_PATTERN.test(result)) {
    EMAIL_PATTERN.lastIndex = 0;
    result = result.replace(EMAIL_PATTERN, "<EMAIL>");
    state.replacements += 1;
  }
  if (key !== undefined && TRANSCRIPT_KEYS.has(key) && isAbsolutePath(result)) {
    return aliasFor(value, state);
  }
  if (result.length > state.options.maxStringLength) {
    const removed = result.length - state.options.maxStringLength;
    result = `${result.slice(0, state.options.maxStringLength)}…<truncated ${removed}>`;
    state.replacements += 1;
  }
  return result;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function aliasFor(value: string, state: RedactionState): string {
  const existing = state.aliases[value];
  if (existing) {
    return existing;
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  const alias = `id_fixture_${digest}`;
  state.aliases[value] = alias;
  state.replacements += 1;
  return alias;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
