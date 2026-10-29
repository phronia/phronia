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

export const DEFAULT_PARALLEL_ENABLED = true;
export const DEFAULT_PARALLEL_MAX_CONCURRENT = 3;
export const DEFAULT_PARALLEL_WORKTREE = "auto" as const;
export const DEFAULT_PARALLEL_WORKTREE_DIR = ".phronia/worktrees";
export const DEFAULT_PARALLEL_WORKTREE_CLEANUP = "on-archive" as const;
export const DEFAULT_PARALLEL_WORKTREE_LOCATION = "persistent" as const;
export const DEFAULT_PARALLEL_INTEGRATION_TIMEOUT = "30m";
export const DEFAULT_PARALLEL_LOCK_TTL = "30m";
export const DEFAULT_PARALLEL_MAX_ATTEMPTS = 3;
export const DEFAULT_PARALLEL_MECHANICAL_MAX_FILES = 5;
export const DEFAULT_PARALLEL_DISPATCH_ENFORCE: DispatchEnforce = "block";

/**
 * Shared files that must never be changed in parallel (design.md §5.5).
 * User config is unioned with these rather than replacing them: losing a
 * safety default is worse than serializing one extra task.
 */
export const DEFAULT_PARALLEL_ALWAYS_SERIAL: readonly string[] = Object.freeze([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "**/migrations/**",
  "**/migration/**",
  "docs/requirements.md",
  ".phronia/config.yaml",
  ".phronia/workflow.md",
  ".phronia/gate.yaml",
]);

/** Generated artifacts that may be regenerated after a rebase conflict. */
export const DEFAULT_PARALLEL_GENERATED: readonly string[] = Object.freeze([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "**/dist/**",
  "**/generated/**",
]);

const TRUE_VALUES = new Set(["true", "yes", "1", "on"]);
const FALSE_VALUES = new Set(["false", "no", "0", "off"]);

export type ParallelIntegrationMode = "auto" | "local" | "remote";
export type ParallelIntegrationConfirm = "auto" | "always" | "never";
export type ParallelWorktreeMode = "auto" | "always" | "never";
export type ParallelWorktreeCleanup = "on-archive" | "on-integrate" | "manual";
export type ParallelWorktreeLocation = "persistent" | "ephemeral";
export type ParallelInputMode = "symlink" | "copy";
export type ParallelCargoTargetDir = "per-worktree" | "shared";

/**
 * A gitignored build input materialized in each worktree (`parallel.inputs`).
 * `path` is repo-relative; the source always lives in the main checkout.
 */
export interface ParallelInput {
  path: string;
  mode: ParallelInputMode;
}

export interface ParallelBuildConfig {
  /** `shared` only produces a recommendation; nothing is set globally. */
  cargoTargetDir: ParallelCargoTargetDir;
  /** Generate sccache setup hints; never installs anything. */
  sccache: boolean;
}

/**
 * `parallel.dispatch.enforce` values. Owned by the config layer because it
 * describes a configuration value; the dispatch policy consumes it.
 */
export type DispatchEnforce = "block" | "warn" | "off";

export interface ParallelIntegrationConfig {
  mode: ParallelIntegrationMode;
  confirm: ParallelIntegrationConfirm;
  /** Branch to integrate into; null means the task's base branch. */
  branch: string | null;
  verify: readonly string[];
  /** Verification timeout, e.g. `30m`. Parsed by the CLI layer. */
  timeout: string;
  /** Integration lock TTL, e.g. `30m`. */
  lockTtl: string;
  maxAttempts: number;
  /**
   * Explicit paths `integrate` may ignore in `git status` when they are
   * symlinks or git-ignored. Never a blanket untracked allow-list.
   */
  ignoredInputs: readonly string[];
}

export interface ParallelConflictsConfig {
  alwaysSerial: readonly string[];
  generated: readonly string[];
  regenerate: readonly string[];
  mechanicalMaxFiles: number;
}

export interface ParallelDispatchConfig {
  /**
   * Whether dispatch admission may block (`block`), downgrade to a guard
   * (`warn`), or stay silent (`off`). S2 only reads this; S3 surfaces it in
   * doctor/platforms.
   */
  enforce: DispatchEnforce;
}

export interface ParallelConfig {
  enabled: boolean;
  maxConcurrent: number;
  worktree: ParallelWorktreeMode;
  /** Relative to the project root, or absolute. */
  worktreeDir: string;
  /** When `task archive` / `integrate` may remove a worktree. */
  cleanup: ParallelWorktreeCleanup;
  /** `persistent` keeps worktrees across restarts; `ephemeral` uses tmp. */
  location: ParallelWorktreeLocation;
  copy: readonly string[];
  postCreate: readonly string[];
  /** Declarative gitignored build inputs (`symlink` or `copy`). */
  inputs: readonly ParallelInput[];
  integration: ParallelIntegrationConfig;
  conflicts: ParallelConflictsConfig;
  dispatch: ParallelDispatchConfig;
  build: ParallelBuildConfig;
}

export const DEFAULT_PARALLEL_CONFIG: ParallelConfig = Object.freeze({
  enabled: DEFAULT_PARALLEL_ENABLED,
  maxConcurrent: DEFAULT_PARALLEL_MAX_CONCURRENT,
  worktree: DEFAULT_PARALLEL_WORKTREE,
  worktreeDir: DEFAULT_PARALLEL_WORKTREE_DIR,
  cleanup: DEFAULT_PARALLEL_WORKTREE_CLEANUP,
  location: DEFAULT_PARALLEL_WORKTREE_LOCATION,
  copy: Object.freeze([]),
  postCreate: Object.freeze([]),
  inputs: Object.freeze([]) as readonly ParallelInput[],
  integration: Object.freeze({
    mode: "auto",
    confirm: "auto",
    branch: null,
    verify: Object.freeze([]),
    timeout: DEFAULT_PARALLEL_INTEGRATION_TIMEOUT,
    lockTtl: DEFAULT_PARALLEL_LOCK_TTL,
    maxAttempts: DEFAULT_PARALLEL_MAX_ATTEMPTS,
    ignoredInputs: Object.freeze([]) as readonly string[],
  }),
  conflicts: Object.freeze({
    alwaysSerial: DEFAULT_PARALLEL_ALWAYS_SERIAL,
    generated: DEFAULT_PARALLEL_GENERATED,
    regenerate: Object.freeze([]),
    mechanicalMaxFiles: DEFAULT_PARALLEL_MECHANICAL_MAX_FILES,
  }),
  dispatch: Object.freeze({
    enforce: DEFAULT_PARALLEL_DISPATCH_ENFORCE,
  }),
  build: Object.freeze({
    cargoTargetDir: "per-worktree" as const,
    sccache: false,
  }),
});

export interface ContextInjectionLimits {
  maxFileBytes: number;
  maxArtifactBytes: number;
  maxTotalBytes: number;
}

export interface PackageConfig {
  path: string;
  /** True when `packages.<name>.path` was explicitly configured. */
  pathExplicit?: boolean;
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
  /** Explicit adapter ids: `platforms.<id>.adapter`. */
  adapterPins: Record<string, string>;
  /** ZCode path override: `platforms.zcode.path`. */
  zcodePath: "plugin" | "project-hooks" | "bridge" | "prelude" | null;
  /** `parallel.*` policy (design.md §11). Missing or invalid values fall back. */
  parallel: ParallelConfig;
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
      adapterPins: readAdapterPins(raw.platforms),
      zcodePath: readZcodePath(raw.platforms),
      parallel: readParallel(raw.parallel, diagnostics, configPath),
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

function readParallel(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): ParallelConfig {
  if (raw === undefined) {
    return DEFAULT_PARALLEL_CONFIG;
  }
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel config: ${JSON.stringify(raw)}; using defaults`,
        { path: configPath },
      ),
    );
    return DEFAULT_PARALLEL_CONFIG;
  }

  const worktree = readParallelWorktree(
    raw.worktree,
    raw.worktree_dir,
    raw.worktree_cleanup,
    raw.worktree_location,
    diagnostics,
    configPath,
  );
  return {
    enabled: coerceBool(
      raw.enabled,
      DEFAULT_PARALLEL_ENABLED,
      "parallel.enabled",
      diagnostics,
      configPath,
    ),
    maxConcurrent: readPositiveInt(
      raw.max_concurrent,
      DEFAULT_PARALLEL_MAX_CONCURRENT,
      "parallel.max_concurrent",
      diagnostics,
      configPath,
    ),
    worktree: worktree.mode,
    worktreeDir: worktree.dir,
    cleanup: worktree.cleanup,
    location: worktree.location,
    copy: readStringList(
      raw.copy,
      "parallel.copy",
      DEFAULT_PARALLEL_CONFIG.copy,
      diagnostics,
      configPath,
    ),
    postCreate: readStringList(
      raw.post_create,
      "parallel.post_create",
      DEFAULT_PARALLEL_CONFIG.postCreate,
      diagnostics,
      configPath,
    ),
    inputs: readParallelInputs(raw.inputs, diagnostics, configPath),
    integration: readParallelIntegration(raw.integration, diagnostics, configPath),
    conflicts: readParallelConflicts(raw.conflicts, diagnostics, configPath),
    dispatch: readParallelDispatch(raw.dispatch, diagnostics, configPath),
    build: readParallelBuild(raw.build, diagnostics, configPath),
  };
}

function readParallelWorktree(
  rawWorktree: YamlValue | undefined,
  rawDir: YamlValue | undefined,
  rawCleanup: YamlValue | undefined,
  rawLocation: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): {
  mode: ParallelWorktreeMode;
  dir: string;
  cleanup: ParallelWorktreeCleanup;
  location: ParallelWorktreeLocation;
} {
  let mode: ParallelWorktreeMode = DEFAULT_PARALLEL_WORKTREE;
  let dir: string = DEFAULT_PARALLEL_WORKTREE_DIR;
  let cleanup: ParallelWorktreeCleanup = DEFAULT_PARALLEL_WORKTREE_CLEANUP;
  let location: ParallelWorktreeLocation = DEFAULT_PARALLEL_WORKTREE_LOCATION;

  if (typeof rawWorktree === "string") {
    mode = readEnum(
      rawWorktree,
      ["auto", "always", "never"] as const,
      DEFAULT_PARALLEL_WORKTREE,
      "parallel.worktree",
      diagnostics,
      configPath,
    );
  } else if (isObject(rawWorktree)) {
    mode = readEnum(
      rawWorktree.mode,
      ["auto", "always", "never"] as const,
      DEFAULT_PARALLEL_WORKTREE,
      "parallel.worktree.mode",
      diagnostics,
      configPath,
    );
    cleanup = readEnum(
      rawWorktree.cleanup,
      ["on-archive", "on-integrate", "manual"] as const,
      DEFAULT_PARALLEL_WORKTREE_CLEANUP,
      "parallel.worktree.cleanup",
      diagnostics,
      configPath,
    );
    location = readEnum(
      rawWorktree.location,
      ["persistent", "ephemeral"] as const,
      DEFAULT_PARALLEL_WORKTREE_LOCATION,
      "parallel.worktree.location",
      diagnostics,
      configPath,
    );
    const dirValue = rawWorktree.dir;
    if (typeof dirValue === "string" && dirValue.trim() !== "") {
      dir = dirValue.trim();
    } else if (dirValue !== undefined) {
      diagnostics.push(
        diagnostic(
          "state.config.invalid_value",
          "warn",
          `invalid parallel.worktree.dir value: ${JSON.stringify(dirValue)}; using ${DEFAULT_PARALLEL_WORKTREE_DIR}`,
          { path: configPath },
        ),
      );
    }
  } else if (rawWorktree !== undefined) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.worktree value: ${JSON.stringify(rawWorktree)}; using ${DEFAULT_PARALLEL_WORKTREE}`,
        { path: configPath },
      ),
    );
  }

  if (typeof rawDir === "string" && rawDir.trim() !== "") {
    dir = rawDir.trim();
  } else if (rawDir !== undefined) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.worktree_dir value: ${JSON.stringify(rawDir)}; using ${DEFAULT_PARALLEL_WORKTREE_DIR}`,
        { path: configPath },
      ),
    );
  }

  // Flat aliases documented in design.md §11 (`parallel.worktree_cleanup`,
  // `parallel.worktree_location`) override the nested form.
  cleanup = readEnum(
    rawCleanup,
    ["on-archive", "on-integrate", "manual"] as const,
    cleanup,
    "parallel.worktree_cleanup",
    diagnostics,
    configPath,
  );
  location = readEnum(
    rawLocation,
    ["persistent", "ephemeral"] as const,
    location,
    "parallel.worktree_location",
    diagnostics,
    configPath,
  );

  return { mode, dir, cleanup, location };
}

function readParallelIntegration(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): ParallelIntegrationConfig {
  const defaults = DEFAULT_PARALLEL_CONFIG.integration;
  if (raw === undefined) {
    return defaults;
  }
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.integration config: ${JSON.stringify(raw)}; using defaults`,
        { path: configPath },
      ),
    );
    return defaults;
  }

  return {
    mode: readEnum(
      raw.mode,
      ["auto", "local", "remote"] as const,
      defaults.mode,
      "parallel.integration.mode",
      diagnostics,
      configPath,
    ),
    confirm: readEnum(
      raw.confirm,
      ["auto", "always", "never"] as const,
      defaults.confirm,
      "parallel.integration.confirm",
      diagnostics,
      configPath,
    ),
    branch: readNullableString(
      raw.branch,
      defaults.branch,
      "parallel.integration.branch",
      diagnostics,
      configPath,
    ),
    verify: readStringList(
      raw.verify,
      "parallel.integration.verify",
      defaults.verify,
      diagnostics,
      configPath,
    ),
    timeout: readDuration(
      raw.timeout,
      defaults.timeout,
      "parallel.integration.timeout",
      diagnostics,
      configPath,
    ),
    lockTtl: readDuration(
      raw.lock_ttl ?? raw.lockTtl,
      defaults.lockTtl,
      "parallel.integration.lock_ttl",
      diagnostics,
      configPath,
    ),
    maxAttempts: readPositiveInt(
      raw.max_attempts ?? raw.maxAttempts,
      defaults.maxAttempts,
      "parallel.integration.max_attempts",
      diagnostics,
      configPath,
    ),
    ignoredInputs: readIgnoredInputs(
      raw.ignored_inputs ?? raw.ignoredInputs,
      diagnostics,
      configPath,
    ),
  };
}

function readParallelConflicts(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): ParallelConflictsConfig {
  const defaults = DEFAULT_PARALLEL_CONFIG.conflicts;
  if (raw === undefined) {
    return defaults;
  }
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.conflicts config: ${JSON.stringify(raw)}; using defaults`,
        { path: configPath },
      ),
    );
    return defaults;
  }

  return {
    alwaysSerial: unionPatterns(
      DEFAULT_PARALLEL_ALWAYS_SERIAL,
      readStringList(
        raw.always_serial,
        "parallel.conflicts.always_serial",
        defaults.alwaysSerial,
        diagnostics,
        configPath,
      ),
    ),
    generated: unionPatterns(
      DEFAULT_PARALLEL_GENERATED,
      readStringList(
        raw.generated,
        "parallel.conflicts.generated",
        defaults.generated,
        diagnostics,
        configPath,
      ),
    ),
    regenerate: readStringList(
      raw.regenerate,
      "parallel.conflicts.regenerate",
      defaults.regenerate,
      diagnostics,
      configPath,
    ),
    mechanicalMaxFiles: readPositiveInt(
      raw.mechanical_max_files ?? raw.mechanicalMaxFiles,
      defaults.mechanicalMaxFiles,
      "parallel.conflicts.mechanical_max_files",
      diagnostics,
      configPath,
    ),
  };
}

function readParallelDispatch(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): ParallelDispatchConfig {
  const defaults = DEFAULT_PARALLEL_CONFIG.dispatch;
  if (raw === undefined) {
    return defaults;
  }
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.dispatch config: ${JSON.stringify(raw)}; using ${defaults.enforce}`,
        { path: configPath },
      ),
    );
    return defaults;
  }
  return {
    enforce: readEnum(
      raw.enforce,
      ["block", "warn", "off"] as const,
      defaults.enforce,
      "parallel.dispatch.enforce",
      diagnostics,
      configPath,
    ),
  };
}

/**
 * Validate a repo-relative config path. Returns the normalized POSIX form, or
 * null for absolute paths, Windows drive paths, empty values, and any `..`.
 * Exported so the CLI can re-check at the IO chokepoint (second gate).
 */
export function normalizeRepoRelativePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/**
 * `parallel.inputs` accepts the documented list of mappings
 * (`- path: x` / `  mode: symlink`), a path→mode mapping, or a plain list of
 * repo-relative paths (mode defaults to `symlink`). Invalid entries are
 * dropped with a diagnostic so one typo cannot block every worktree.
 */
function readParallelInputs(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): readonly ParallelInput[] {
  if (raw === undefined) {
    return DEFAULT_PARALLEL_CONFIG.inputs;
  }
  const entries: {
    rawPath: YamlValue | undefined;
    rawMode: YamlValue | undefined;
    label: string;
  }[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        entries.push({ rawPath: item, rawMode: undefined, label: "parallel.inputs" });
      } else if (isObject(item)) {
        entries.push({
          rawPath: item.path,
          rawMode: item.mode,
          label: "parallel.inputs",
        });
      } else {
        diagnostics.push(
          diagnostic(
            "state.config.invalid_value",
            "warn",
            `invalid parallel.inputs entry: ${JSON.stringify(item)}; ignoring`,
            { path: configPath },
          ),
        );
      }
    }
  } else if (isObject(raw)) {
    if (typeof raw.path === "string") {
      // A single `{ path, mode }` mapping is accepted as a one-entry list.
      entries.push({ rawPath: raw.path, rawMode: raw.mode, label: "parallel.inputs" });
    } else {
      // `inputs: { rust/web/node_modules: symlink }` is the parser-friendly form.
      for (const [key, value] of Object.entries(raw)) {
        entries.push({ rawPath: key, rawMode: value, label: "parallel.inputs" });
      }
    }
  } else {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.inputs value: ${JSON.stringify(raw)}; ignoring`,
        { path: configPath },
      ),
    );
    return DEFAULT_PARALLEL_CONFIG.inputs;
  }

  const out: ParallelInput[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const inputPath = normalizeRepoRelativePath(entry.rawPath);
    if (inputPath === null) {
      diagnostics.push(
        diagnostic(
          "state.config.invalid_value",
          "warn",
          `invalid ${entry.label} path: ${JSON.stringify(entry.rawPath)}; expected a repo-relative path without ".."`,
          { path: configPath },
        ),
      );
      continue;
    }
    const mode = readInputMode(entry.rawMode, inputPath, diagnostics, configPath);
    if (mode === null) {
      continue;
    }
    if (seen.has(inputPath)) {
      continue;
    }
    seen.add(inputPath);
    out.push({ path: inputPath, mode });
  }
  return out;
}

function readInputMode(
  raw: YamlValue | undefined,
  inputPath: string,
  diagnostics: Diagnostic[],
  configPath: string,
): ParallelInputMode | null {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    // A bare path keeps the copy list's spirit but symlinks are the primary
    // use case: sharing a large gitignored dependency tree.
    return "symlink";
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "symlink" || normalized === "copy") {
    return normalized;
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid parallel.inputs mode for ${inputPath}: ${JSON.stringify(raw)}; expected symlink|copy, ignoring the entry`,
      { path: configPath },
    ),
  );
  return null;
}

function readIgnoredInputs(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): readonly string[] {
  if (raw === undefined) {
    return DEFAULT_PARALLEL_CONFIG.integration.ignoredInputs;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const inputPath = normalizeRepoRelativePath(item);
    if (inputPath === null) {
      diagnostics.push(
        diagnostic(
          "state.config.invalid_value",
          "warn",
          `invalid parallel.integration.ignored_inputs entry: ${JSON.stringify(item)}; expected a repo-relative path without ".."`,
          { path: configPath },
        ),
      );
      continue;
    }
    if (seen.has(inputPath)) {
      continue;
    }
    seen.add(inputPath);
    out.push(inputPath);
  }
  return out;
}

function readParallelBuild(
  raw: YamlValue | undefined,
  diagnostics: Diagnostic[],
  configPath: string,
): ParallelBuildConfig {
  const defaults = DEFAULT_PARALLEL_CONFIG.build;
  if (raw === undefined) {
    return defaults;
  }
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic(
        "state.config.invalid_value",
        "warn",
        `invalid parallel.build config: ${JSON.stringify(raw)}; using defaults`,
        { path: configPath },
      ),
    );
    return defaults;
  }
  return {
    cargoTargetDir: readEnum(
      raw.cargo_target_dir ?? raw.cargoTargetDir,
      ["per-worktree", "shared"] as const,
      defaults.cargoTargetDir,
      "parallel.build.cargo_target_dir",
      diagnostics,
      configPath,
    ),
    sccache: coerceBool(
      raw.sccache,
      defaults.sccache,
      "parallel.build.sccache",
      diagnostics,
      configPath,
    ),
  };
}

function readEnum<T extends string>(
  raw: YamlValue | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
  diagnostics: Diagnostic[],
  configPath: string,
): T {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  const match = allowed.find((value) => value === normalized);
  if (match !== undefined) {
    return match;
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid ${label} value: ${JSON.stringify(raw)}; using ${fallback} (${allowed.join("|")})`,
      { path: configPath },
    ),
  );
  return fallback;
}

function readPositiveInt(
  raw: YamlValue | undefined,
  fallback: number,
  label: string,
  diagnostics: Diagnostic[],
  configPath: string,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid ${label} value: ${JSON.stringify(raw)}; using ${fallback}`,
      { path: configPath },
    ),
  );
  return fallback;
}

function readDuration(
  raw: YamlValue | undefined,
  fallback: string,
  label: string,
  diagnostics: Diagnostic[],
  configPath: string,
): string {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (/^\d+(?:ms|s|m|h|d)?$/.test(value)) {
      return value;
    }
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid ${label} value: ${JSON.stringify(raw)}; using ${fallback}`,
      { path: configPath },
    ),
  );
  return fallback;
}

function readNullableString(
  raw: YamlValue | undefined,
  fallback: string | null,
  label: string,
  diagnostics: Diagnostic[],
  configPath: string,
): string | null {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw === "string") {
    return raw.trim() === "" ? null : raw.trim();
  }
  diagnostics.push(
    diagnostic(
      "state.config.invalid_value",
      "warn",
      `invalid ${label} value: ${JSON.stringify(raw)}; using ${fallback ?? "null"}`,
      { path: configPath },
    ),
  );
  return fallback;
}

/** Read a scalar or `- ` list into a trimmed string list (never throws). */
function readStringList(
  raw: YamlValue | undefined,
  label: string,
  fallback: readonly string[],
  diagnostics: Diagnostic[],
  configPath: string,
): readonly string[] {
  if (raw === undefined) {
    return fallback;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      diagnostics.push(
        diagnostic(
          "state.config.invalid_value",
          "warn",
          `invalid ${label} entry: ${JSON.stringify(item)}; ignoring`,
          { path: configPath },
        ),
      );
      continue;
    }
    const value = item.trim();
    if (value !== "") {
      out.push(value);
    }
  }
  return out;
}

/** Union safety defaults with configured patterns (case-insensitive). */
function unionPatterns(
  defaults: readonly string[],
  configured: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of [...defaults, ...configured]) {
    const key = pattern.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(pattern);
  }
  return out;
}

/**
 * Map explicitly configured package paths for footprint normalization.
 *
 * Packages without an explicit `path` are omitted so `normalizeFootprint`
 * keeps its `packages/<name>/**` fallback instead of treating the package
 * name itself as a directory.
 */
export function packagePathMap(
  config: Pick<ConfigView, "packages">,
): Record<string, string> {
  const paths: Record<string, string> = {};
  if (config.packages === null) {
    return paths;
  }
  for (const [name, pkg] of Object.entries(config.packages)) {
    if (pkg.pathExplicit !== true) {
      continue;
    }
    paths[name] = pkg.path;
  }
  return paths;
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
    const explicitPath =
      typeof value.path === "string" && value.path.trim() !== "";
    packages[name] = {
      path: stringOrDefault(value.path, name),
      ...(explicitPath ? { pathExplicit: true } : {}),
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

function readAdapterPins(raw: YamlValue | undefined): Record<string, string> {
  const platforms = asMap(raw);
  if (!platforms) return {};
  const pins: Record<string, string> = {};
  for (const [id, value] of Object.entries(platforms)) {
    const entry = asMap(value);
    const adapter = entry ? stringOrNull(entry.adapter) : null;
    if (adapter) pins[id] = adapter;
  }
  return pins;
}

function readZcodePath(
  raw: YamlValue | undefined,
): "plugin" | "project-hooks" | "bridge" | "prelude" | null {
  const platforms = asMap(raw);
  const zcode = platforms ? asMap(platforms.zcode) : null;
  const value = zcode ? stringOrNull(zcode.path) : null;
  return value === "plugin" ||
    value === "project-hooks" ||
    value === "bridge" ||
    value === "prelude"
    ? value
    : null;
}

function asMap(value: YamlValue | undefined): YamlObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as YamlObject)
    : null;
}
