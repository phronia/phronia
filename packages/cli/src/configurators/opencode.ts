import fs, { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AI_TOOLS } from "../types/ai-tools.js";
import { getOpenCodeTemplatePath } from "../templates/extract.js";
import { toPosix } from "../utils/posix.js";
import {
  collectSkillTemplates,
  replacePythonCommandLiterals,
  resolveBundledSkills,
  resolveCommands,
  resolveSkills,
} from "./shared.js";

export const OPENCODE_V1 = "opencode@v1";
export const OPENCODE_V2 = "opencode@v2";
export type OpenCodeAdapterId = typeof OPENCODE_V1 | typeof OPENCODE_V2;

export const OPENCODE_ADAPTERS: readonly OpenCodeAdapterId[] = [
  OPENCODE_V1,
  OPENCODE_V2,
];

/**
 * Files under packages/cli/src/templates/opencode/ that are NOT user-facing
 * assets (build artifacts, runtime caches, etc.).
 */
const EXCLUDE_PATTERNS = [
  ".d.ts",
  ".d.ts.map",
  ".js.map",
  "__pycache__",
  "node_modules",
  "bun.lock",
  ".gitignore",
];

function shouldExclude(filename: string): boolean {
  for (const pattern of EXCLUDE_PATTERNS) {
    if (filename.endsWith(pattern) || filename === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Paths each generation owns inside the user's project. Reconciliation uses
 * these to remove a retired shard without touching the shared base
 * (agents/commands/skills) or files the user added.
 */
const V1_OWNED_PATHS = [
  ".opencode/plugins/session-start.js",
  ".opencode/plugins/inject-workflow-state.js",
  ".opencode/plugins/inject-subagent-context.js",
  ".opencode/lib/debug.js",
  ".opencode/lib/phronia-client.js",
  ".opencode/lib/context-visibility.js",
  ".opencode/lib/session-utils.js",
  ".opencode/package.json",
] as const;

const V2_OWNED_PATHS = [".opencode/plugins/phronia.js"] as const;

function generatedShimDir(adapterId: OpenCodeAdapterId): string {
  const sourcePath = getOpenCodeTemplatePath();
  return path.resolve(
    sourcePath,
    "..",
    "_generated/shims",
    adapterId === OPENCODE_V2 ? "v2" : "v1",
  );
}

function addTree(
  files: Map<string, string>,
  sourceRoot: string,
  relDir: string,
  destPrefix: string,
): void {
  const absDir = path.join(sourceRoot, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of readdirSync(absDir)) {
    if (shouldExclude(entry)) continue;
    const absEntry = path.join(absDir, entry);
    const stat = statSync(absEntry);
    if (stat.isDirectory()) {
      addTree(files, sourceRoot, path.posix.join(relDir, entry), destPrefix);
      continue;
    }
    const rel = path.posix.join(relDir, entry);
    const dest = path.posix.join(destPrefix, rel.slice(relDir.length).replace(/^\//, ""));
    files.set(
      toPosix(dest),
      replacePythonCommandLiterals(readFileSync(absEntry, "utf-8")),
    );
  }
}

function addGeneratedShims(
  files: Map<string, string>,
  adapterId: OpenCodeAdapterId,
): boolean {
  const generated = generatedShimDir(adapterId);
  if (!fs.existsSync(generated)) return false;
  let added = false;
  for (const entry of readdirSync(generated)) {
    if (!entry.endsWith(".js")) continue;
    files.set(
      `.opencode/plugins/${entry}`,
      fs.readFileSync(path.join(generated, entry), "utf-8"),
    );
    added = true;
  }
  return added;
}

/**
 * Generation-independent assets. Agents are file-based in both OpenCode v1
 * and v2, so they stay in one place.
 */
function collectOpenCodeBase(): Map<string, string> {
  const files = new Map<string, string>();
  addTree(files, getOpenCodeTemplatePath(), "base/agents", ".opencode/agents");
  return files;
}

/**
 * Generation-specific files. The build artifacts are preferred; the v1 source
 * tree remains a development fallback. v2 has no source fallback because the
 * source file imports sibling modules that must be bundled into one artifact.
 */
export function collectOpenCodeShard(
  adapterId: OpenCodeAdapterId = OPENCODE_V1,
): Map<string, string> {
  const files = new Map<string, string>();
  const sourceRoot = getOpenCodeTemplatePath();

  if (addGeneratedShims(files, adapterId)) {
    if (adapterId === OPENCODE_V1) {
      // The v1 bundle inlines its helpers, but the lib files remain part of the
      // managed set: earlier installs tracked them and `update` must keep
      // diffing them instead of treating them as user files.
      addTree(files, sourceRoot, "adapters/v1/lib", ".opencode/lib");
      const manifest = path.join(sourceRoot, "adapters/v1/package.json");
      files.set(".opencode/package.json", readFileSync(manifest, "utf-8"));
    }
    return files;
  }

  if (adapterId === OPENCODE_V2) {
    throw new Error(
      "OpenCode v2 shim is missing; run `pnpm build:shims` before configuring v2",
    );
  }

  addTree(files, sourceRoot, "adapters/v1/plugins", ".opencode/plugins");
  addTree(files, sourceRoot, "adapters/v1/lib", ".opencode/lib");
  files.set(
    ".opencode/package.json",
    readFileSync(path.join(sourceRoot, "adapters/v1/package.json"), "utf-8"),
  );
  return files;
}

export function openCodeShardOwnedPaths(
  adapterId: OpenCodeAdapterId,
): readonly string[] {
  return adapterId === OPENCODE_V2 ? V2_OWNED_PATHS : V1_OWNED_PATHS;
}

function normalizeAdapterId(
  adapterId: string | null | undefined,
): OpenCodeAdapterId {
  return adapterId === OPENCODE_V2 ? OPENCODE_V2 : OPENCODE_V1;
}

/**
 * The opencode file set — written at init and diffed by `phronia update`.
 * Both paths call this with the same adapter id, so they cannot disagree.
 */
export function collectOpenCodeTemplates(
  options: string | { adapterId?: string } | null | undefined = OPENCODE_V1,
): Map<string, string> {
  const adapterId =
    typeof options === "string" ? options : options?.adapterId ?? OPENCODE_V1;
  const files = collectOpenCodeBase();
  for (const [filePath, content] of collectOpenCodeShard(
    normalizeAdapterId(adapterId),
  )) {
    files.set(filePath, content);
  }

  const ctx = AI_TOOLS.opencode.templateContext;
  for (const cmd of resolveCommands(ctx)) {
    files.set(`.opencode/commands/phronia/${cmd.name}.md`, cmd.content);
  }
  for (const [filePath, content] of collectSkillTemplates(
    ".opencode/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }
  return files;
}
