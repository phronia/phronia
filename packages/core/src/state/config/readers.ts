/**
 * Typed views over `.phronia/config.yaml`.
 *
 * Mirrors `templates/workflow/scripts/common/config.py`: every value is a
 * string after parsing, coercions are explicit, and invalid values fall back
 * with the same warning behaviour as the Python implementation.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { readText, type FsLike } from "../fs.js";
import { parseSimpleYaml, type YamlObject, type YamlValue } from "./yaml.js";

export const DEFAULT_SESSION_COMMIT_MESSAGE = "chore: record journal";
export const DEFAULT_MAX_JOURNAL_LINES = 2000;
export const DEFAULT_SESSION_AUTO_COMMIT = true;
export const DEFAULT_CODEX_DISPATCH_MODE = "auto";
export const DEFAULT_CONTEXT_INJECTION_MAX_FILE_BYTES = 32768;
export const DEFAULT_CONTEXT_INJECTION_MAX_ARTIFACT_BYTES = 65536;
export const DEFAULT_CONTEXT_INJECTION_MAX_TOTAL_BYTES = 131072;
export const DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-trellis";

const TRUE_VALUES = new Set(["true", "yes", "1", "on"]);
const FALSE_VALUES = new Set(["false", "no", "0", "off"]);

export interface ContextInjectionLimits {
  maxFileBytes: number;
  maxArtifactBytes: number;
  maxTotalBytes: number;
}

export interface PackageConfig {
  path: string;
  type?: string;
  git?: boolean;
}

export interface ConfigView {
  sessionCommitMessage: string;
  maxJournalLines: number;
  sessionAutoCommit: boolean;
  codexDispatchMode: "auto" | "inline";
  contextInjection: ContextInjectionLimits;
  promptInjection: { skipKeyword: string };
  /** null means single-repo mode. */
  packages: Record<string, PackageConfig> | null;
  defaultPackage: string | null;
  /** "active_task", an explicit package list, or null for a full scan. */
  specScope: string | string[] | null;
}

export interface ConfigReadResult {
  value: ConfigView;
  diagnostics: readonly Diagnostic[];
  raw: YamlObject;
}

export function readConfig(
  root: string,
  io: FsLike,
): ConfigReadResult {
  const configPath = path.join(root, LAYOUT.paths.config);
  const diagnostics: Diagnostic[] = [];
  const content = readText(io, configPath);
  let raw: YamlObject = {};

  if (content !== null) {
    const parsed = parseSimpleYaml(content);
    raw = parsed.value;
    for (const warning of parsed.warnings) {
      diagnostics.push(
        diagnostic(
          "state.config.unsupported_construct",
          "info",
          `${warning.reason}; ignoring: ${warning.text.trim()}`,
          { path: configPath, details: { line: warning.line } },
        ),
      );
    }
  }

  return {
    value: {
      sessionCommitMessage: stringOrDefault(
        raw.session_commit_message,
        DEFAULT_SESSION_COMMIT_MESSAGE,
      ),
      maxJournalLines: intOrDefault(
        raw.max_journal_lines,
        DEFAULT_MAX_JOURNAL_LINES,
      ),
      sessionAutoCommit: coerceBool(
        raw.session_auto_commit,
        DEFAULT_SESSION_AUTO_COMMIT,
        "session_auto_commit",
        diagnostics,
        configPath,
      ),
      codexDispatchMode: readCodexDispatchMode(raw.codex, diagnostics, configPath),
      contextInjection: readContextInjectionLimits(
        raw.context_injection,
        diagnostics,
        configPath,
      ),
      promptInjection: {
        skipKeyword: readSkipKeyword(raw.prompt_injection),
      },
      packages: readPackages(raw.packages),
      defaultPackage: stringOrNull(raw.default_package),
      specScope: readSpecScope(raw.session),
    },
    diagnostics,
    raw,
  };
}

function readCodexDispatchMode(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): "auto" | "inline" {
  if (raw === undefined) {
    return DEFAULT_CODEX_DISPATCH_MODE;
  }
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid codex config: ${JSON.stringify(raw)}; using inline`,
        { path: configPath },
      ),
    );
    return "inline";
  }
  const rawMode = raw.dispatch_mode ?? DEFAULT_CODEX_DISPATCH_MODE;
  const mode = String(rawMode).trim().toLowerCase();
  if (mode === "auto" || mode === "inline") {
    return mode;
  }
  if (mode === "sub-agent") {
    return "auto";
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid codex.dispatch_mode value: ${JSON.stringify(rawMode)}; using inline`,
      { path: configPath },
    ),
  );
  return "inline";
}

function readContextInjectionLimits(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): ContextInjectionLimits {
  const defaults: ContextInjectionLimits = {
    maxFileBytes: DEFAULT_CONTEXT_INJECTION_MAX_FILE_BYTES,
    maxArtifactBytes: DEFAULT_CONTEXT_INJECTION_MAX_ARTIFACT_BYTES,
    maxTotalBytes: DEFAULT_CONTEXT_INJECTION_MAX_TOTAL_BYTES,
  };
  if (!isObject(raw)) {
    return defaults;
  }

  const result = { ...defaults };
  const keys: [keyof ContextInjectionLimits, string, number][] = [
    ["maxFileBytes", "max_file_bytes", defaults.maxFileBytes],
    ["maxArtifactBytes", "max_artifact_bytes", defaults.maxArtifactBytes],
    ["maxTotalBytes", "max_total_bytes", defaults.maxTotalBytes],
  ];

  for (const [field, key, fallback] of keys) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      diagnostics.push(
        diagnostic(
          "state.config.invalid_value",
          "warn",
          `invalid context_injection.${key} value: ${JSON.stringify(value)}; using default ${fallback}`,
          { path: configPath },
        ),
      );
      continue;
    }
    result[field] = parsed;
  }
  return result;
}

function readSkipKeyword(raw: YamlValue | undefined): string {
  if (!isObject(raw)) {
    return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD;
  }
  const value = raw.skip_keyword;
  return typeof value === "string"
    ? value
    : DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD;
}

function coerceBool(
  raw: YamlValue | undefined,
  fallback: boolean,
  label: string,
  diagnostics: Diagnostic[],
  configPath: string,
): boolean {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid ${label} value: ${JSON.stringify(raw)}; using ${String(fallback).toLowerCase()} (default)`,
      { path: configPath },
    ),
  );
  return fallback;
}

function intOrDefault(raw: YamlValue | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOrDefault(raw: YamlValue | undefined, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

function stringOrNull(raw: YamlValue | undefined): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function readPackages(raw: YamlValue | undefined): Record<string, PackageConfig> | null {
  if (!isObject(raw)) {
    return null;
  }
  const packages: Record<string, PackageConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      continue;
    }
    packages[name] = {
      path: stringOrDefault(value.path, name),
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.git === "boolean"
        ? { git: value.git }
        : value.git === "true"
          ? { git: true }
          : {}),
    };
  }
  return Object.keys(packages).length > 0 ? packages : null;
}

function readSpecScope(raw: YamlValue | undefined): string | string[] | null {
  if (!isObject(raw)) {
    return null;
  }
  const scope = raw.spec_scope;
  if (typeof scope === "string") {
    return scope;
  }
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === "string");
  }
  return null;
}

function isObject(value: YamlValue | undefined): value is YamlObject {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}
