/**
 * One-time adoption of an upstream Phronia project into Phronia.
 *
 * Contract (ADR-0002):
 * - user-owned content is never deleted; generated files are regenerated;
 * - only files whose content matches the old manifest are removed;
 * - local edits survive as `<path>.pre-adopt` and are reported for review;
 * - a full backup is written outside the repository before anything moves;
 * - the command is idempotent and refuses ambiguous states.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { PLATFORM_IDS, getPlatformFunctions } from "../configurators/index.js";
import { AI_TOOLS, type AITool } from "../types/ai-tools.js";
import { VERSION } from "../constants/version.js";
import { FILE_NAMES } from "../constants/paths.js";
import { LAYOUT } from "@phronia/core/layout";
import { ensureGitattributes } from "../configurators/workflow.js";
import { replacePythonCommandLiterals } from "../configurators/shared.js";
import {
  configYamlTemplate,
  getAllAgents,
  getAllScripts,
  getScriptSupportFiles,
  gitignoreTemplate,
  workflowMdTemplate,
} from "../templates/workflow/index.js";
import { buildAgentsMdTemplate } from "../utils/managed-block.js";
import { computeHash, initializeHashes } from "../utils/template-hash.js";
import { cleanupEmptyDirs } from "../utils/managed-paths.js";

export interface AdoptOptions {
  cwd: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  /** Override the backup root (tests use a temp directory). */
  backupRoot?: string;
}

export interface AdoptReport {
  dryRun: boolean;
  legacyDir: string;
  currentDir: string;
  fromVersion: string | null;
  platforms: AITool[];
  backupDir: string | null;
  kept: string[];
  dropped: string[];
  regenerated: string[];
  needsReview: string[];
  warnings: string[];
}

interface LegacyManifest {
  __version?: number;
  hashes?: Record<string, string>;
}

const LEGACY_DIR = LAYOUT.legacyRootDirName;
const CURRENT_DIR = LAYOUT.rootDirName;

export async function adopt(options: AdoptOptions): Promise<AdoptReport> {
  const cwd = path.resolve(options.cwd);
  const legacyDir = path.join(cwd, LEGACY_DIR);
  const currentDir = path.join(cwd, CURRENT_DIR);

  assertAdoptable(cwd, legacyDir, currentDir, options.force ?? false);

  const manifest = readLegacyManifest(legacyDir);
  const manifestKeys = Object.keys(manifest.hashes ?? {});
  const platforms = detectPlatforms(cwd, manifestKeys);
  const fromVersion = readVersion(legacyDir);

  const report: AdoptReport = {
    dryRun: options.dryRun ?? false,
    legacyDir: LEGACY_DIR,
    currentDir: CURRENT_DIR,
    fromVersion,
    platforms,
    backupDir: null,
    kept: [],
    dropped: [],
    regenerated: [],
    needsReview: [],
    warnings: [],
  };

  if (platforms.length === 0) {
    report.warnings.push(
      "No configured platform was detected from the legacy manifest; only the workflow directory will be migrated.",
    );
  }

  if (report.dryRun) {
    planPristineDeletions(cwd, manifest, report);
    planWorkflowRefresh(cwd, manifest, report);
    planConflicts(cwd, platforms, report);
    return report;
  }

  report.backupDir = createBackup(cwd, platforms, legacyDir, options.backupRoot);
  fs.renameSync(legacyDir, currentDir);

  // Remove generated files that still match the old manifest. Anything the
  // user changed is preserved and listed for review.
  for (const [relativePath, expectedHash] of Object.entries(manifest.hashes ?? {})) {
    if (isWorkflowPath(relativePath)) {
      continue;
    }
    removeIfPristine(cwd, relativePath, expectedHash, report);
  }

  // The renamed workflow tree still carries upstream scripts, workflow.md and
  // config.yaml. Regenerate them here so adoption is complete without a
  // follow-up `update`, and keep user edits as `.pre-adopt`.
  const workflowPlan = workflowRefreshPlan(cwd, manifest);
  preserveWorkflowConflicts(cwd, workflowPlan, report);
  writeWorkflowFiles(cwd, workflowPlan);
  report.regenerated.push("workflow", FILE_NAMES.AGENTS);

  // Move local edits out of the way before regenerating their paths.
  for (const platform of platforms) {
    const files = getPlatformFunctions()[platform].collectTemplates?.();
    if (!files) {
      continue;
    }
    for (const relativePath of files.keys()) {
      preserveConflict(cwd, relativePath, report);
    }
  }

  for (const platform of platforms) {
    try {
      await getPlatformFunctions()[platform].configure(cwd);
      report.regenerated.push(platform);
    } catch (error) {
      report.warnings.push(
        `Failed to regenerate ${AI_TOOLS[platform].name}: ${errorMessage(error)}`,
      );
    }
  }

  renameLegacyDirectories(cwd, report);
  writeVersion(currentDir);
  const tracked = new Set<string>();
  for (const platform of platforms) {
    const files = getPlatformFunctions()[platform].collectTemplates?.();
    for (const key of files?.keys() ?? []) {
      tracked.add(key);
    }
  }
  initializeHashes(cwd, { trackedPaths: tracked });
  writeReport(currentDir, report);

  return report;
}

function assertAdoptable(
  cwd: string,
  legacyDir: string,
  currentDir: string,
  force: boolean,
): void {
  if (!fs.existsSync(legacyDir)) {
    throw new Error(
      fs.existsSync(currentDir)
        ? `Already adopted: ${CURRENT_DIR}/ exists and ${LEGACY_DIR}/ does not.`
        : `Nothing to adopt: ${LEGACY_DIR}/ not found in ${cwd}.`,
    );
  }
  if (fs.existsSync(currentDir)) {
    throw new Error(
      `Both ${LEGACY_DIR}/ and ${CURRENT_DIR}/ exist. Resolve the conflict manually; adopt will not guess.`,
    );
  }
  if (force) {
    return;
  }
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if (status.status === 0 && (status.stdout ?? "").trim().length > 0) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes first, or pass --force.",
    );
  }
}

function readLegacyManifest(legacyDir: string): LegacyManifest {
  try {
    const raw = fs.readFileSync(
      path.join(legacyDir, ".template-hashes.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as LegacyManifest;
    if (parsed && typeof parsed === "object" && typeof parsed.hashes === "object") {
      return parsed;
    }
  } catch {
    // Missing or malformed manifests are normal for hand-built projects.
  }
  return {};
}

function readVersion(legacyDir: string): string | null {
  try {
    return fs.readFileSync(path.join(legacyDir, ".version"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function detectPlatforms(cwd: string, manifestKeys: readonly string[]): AITool[] {
  const detected: AITool[] = [];
  for (const id of PLATFORM_IDS) {
    const config = AI_TOOLS[id];
    const roots = [config.configDir, ...(config.extraManagedPaths ?? [])];
    const fromManifest = roots.some((root) =>
      manifestKeys.some((key) => key === root || key.startsWith(`${root}/`)),
    );
    const fromDisk = roots.some((root) => fs.existsSync(path.join(cwd, root)));
    if (manifestKeys.length === 0 ? fromDisk : fromManifest) {
      detected.push(id);
    }
  }
  return detected;
}

function isWorkflowPath(relativePath: string): boolean {
  return (
    relativePath === LEGACY_DIR || relativePath.startsWith(`${LEGACY_DIR}/`)
  );
}

function planPristineDeletions(
  cwd: string,
  manifest: LegacyManifest,
  report: AdoptReport,
): void {
  for (const [relativePath, expectedHash] of Object.entries(manifest.hashes ?? {})) {
    if (isWorkflowPath(relativePath)) {
      continue;
    }
    const fullPath = path.join(cwd, ...relativePath.split("/"));
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    if (computeHash(fs.readFileSync(fullPath, "utf8")) === expectedHash) {
      report.dropped.push(relativePath);
    } else {
      report.needsReview.push(relativePath);
    }
  }
}

function planConflicts(
  cwd: string,
  platforms: readonly AITool[],
  report: AdoptReport,
): void {
  for (const platform of platforms) {
    const files = getPlatformFunctions()[platform].collectTemplates?.();
    for (const relativePath of files?.keys() ?? []) {
      if (!fs.existsSync(path.join(cwd, ...relativePath.split("/")))) {
        continue;
      }
      if (!report.needsReview.includes(relativePath)) {
        report.needsReview.push(relativePath);
      }
    }
  }
}

interface WorkflowRefreshPlan {
  files: Map<string, string>;
  conflicts: string[];
}

/**
 * The workflow tree is renamed as a whole, so its generated files still carry
 * upstream content and legacy root paths. Adoption owns these files the same
 * way `init`/`update` do: write current templates and preserve user edits.
 */
function workflowRefreshPlan(
  cwd: string,
  manifest: LegacyManifest,
): WorkflowRefreshPlan {
  const files = new Map<string, string>();
  for (const [scriptPath, content] of getAllScripts()) {
    files.set(
      `${LAYOUT.paths.scripts}/${scriptPath}`,
      replacePythonCommandLiterals(content),
    );
  }
  for (const [scriptPath, content] of getScriptSupportFiles()) {
    files.set(`${LAYOUT.paths.scripts}/${scriptPath}`, content);
  }
  for (const [agentFile, content] of getAllAgents()) {
    files.set(
      `${LAYOUT.paths.agents}/${agentFile}`,
      replacePythonCommandLiterals(content),
    );
  }
  files.set(
    LAYOUT.paths.config,
    replacePythonCommandLiterals(configYamlTemplate),
  );
  files.set(`${LAYOUT.paths.root}/.gitignore`, gitignoreTemplate);
  files.set(
    LAYOUT.paths.workflow,
    replacePythonCommandLiterals(workflowMdTemplate),
  );
  files.set(FILE_NAMES.AGENTS, buildAgentsMdTemplate(cwd));

  const conflicts: string[] = [];
  for (const [relativePath, content] of files) {
    const fullPath = path.join(cwd, ...relativePath.split("/"));
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    let existing: string;
    try {
      existing = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (existing === content) {
      continue;
    }
    const legacyPath = relativePath.startsWith(`${CURRENT_DIR}/`)
      ? `${LEGACY_DIR}/${relativePath.slice(CURRENT_DIR.length + 1)}`
      : relativePath;
    const expected =
      manifest.hashes?.[legacyPath] ?? manifest.hashes?.[relativePath];
    // A hash match means the file is still the upstream template, so replacing
    // it loses nothing. Anything else is a local edit worth keeping, except
    // generated executable code: scripts have no user-facing settings and the
    // full pre-adoption backup already covers them.
    if (expected !== undefined && computeHash(existing) === expected) {
      continue;
    }
    const isGeneratedCode =
      relativePath.startsWith(`${LAYOUT.paths.scripts}/`) ||
      relativePath.startsWith(`${LAYOUT.paths.agents}/`);
    if (expected === undefined && isGeneratedCode) {
      continue;
    }
    conflicts.push(relativePath);
  }

  return { files, conflicts };
}

function planWorkflowRefresh(
  cwd: string,
  manifest: LegacyManifest,
  report: AdoptReport,
): void {
  const plan = workflowRefreshPlan(cwd, manifest);
  for (const relativePath of plan.conflicts) {
    if (!report.needsReview.includes(relativePath)) {
      report.needsReview.push(relativePath);
    }
  }
}

function preserveWorkflowConflicts(
  cwd: string,
  plan: WorkflowRefreshPlan,
  report: AdoptReport,
): void {
  for (const relativePath of plan.conflicts) {
    preserveConflict(cwd, relativePath, report);
  }
}

function writeWorkflowFiles(cwd: string, plan: WorkflowRefreshPlan): void {
  for (const [relativePath, content] of plan.files) {
    const fullPath = path.join(cwd, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  ensureGitattributes(cwd);
}

function removeIfPristine(
  cwd: string,
  relativePath: string,
  expectedHash: string,
  report: AdoptReport,
): void {
  const fullPath = path.join(cwd, ...relativePath.split("/"));
  if (!fs.existsSync(fullPath)) {
    return;
  }
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    if (computeHash(content) === expectedHash) {
      fs.rmSync(fullPath, { force: true });
      report.dropped.push(relativePath);
      return;
    }
  } catch {
    // Binary or unreadable file: keep it.
  }
  report.kept.push(relativePath);
  report.needsReview.push(relativePath);
}

function preserveConflict(
  cwd: string,
  relativePath: string,
  report: AdoptReport,
): void {
  const fullPath = path.join(cwd, ...relativePath.split("/"));
  if (!fs.existsSync(fullPath)) {
    return;
  }
  const backupPath = `${fullPath}.pre-adopt`;
  fs.renameSync(fullPath, backupPath);
  if (!report.needsReview.includes(relativePath)) {
    report.needsReview.push(relativePath);
  }
}

function renameLegacyDirectories(cwd: string, report: AdoptReport): void {
  for (const id of PLATFORM_IDS) {
    const config = AI_TOOLS[id];
    const roots = [config.configDir, ...(config.extraManagedPaths ?? [])];
    for (const root of roots) {
      const absolute = path.join(cwd, root);
      if (!fs.existsSync(absolute)) {
        continue;
      }
      renamePrefixedEntries(absolute, report);
      try {
        cleanupEmptyDirs(cwd, root);
      } catch {
        // Best effort.
      }
    }
  }
}

function renamePrefixedEntries(directory: string, report: AdoptReport): void {
  if (!fs.existsSync(directory)) {
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith("trellis-")) {
      continue;
    }
    const nextName = `phronia-${entry.name.slice("trellis-".length)}`;
    const source = path.join(directory, entry.name);
    const target = path.join(directory, nextName);
    if (fs.existsSync(target)) {
      report.needsReview.push(path.relative(process.cwd(), source));
      continue;
    }
    fs.renameSync(source, target);
    report.regenerated.push(path.relative(process.cwd(), target));
  }
}

function createBackup(
  cwd: string,
  platforms: readonly AITool[],
  legacyDir: string,
  backupRoot?: string,
): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = backupRoot ?? path.join(os.homedir(), ".phronia", "backups");
  const backupDir = path.join(root, key, stamp);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  fs.cpSync(legacyDir, path.join(backupDir, LEGACY_DIR), { recursive: true });
  for (const id of platforms) {
    const config = AI_TOOLS[id];
    for (const root of [config.configDir, ...(config.extraManagedPaths ?? [])]) {
      const from = path.join(cwd, root);
      if (fs.existsSync(from)) {
        fs.cpSync(from, path.join(backupDir, root), { recursive: true });
      }
    }
  }
  const agents = path.join(cwd, "AGENTS.md");
  if (fs.existsSync(agents)) {
    fs.copyFileSync(agents, path.join(backupDir, "AGENTS.md"));
  }
  return backupDir;
}

function writeVersion(currentDir: string): void {
  fs.writeFileSync(path.join(currentDir, ".version"), `${VERSION}\n`, "utf8");
}

function writeReport(currentDir: string, report: AdoptReport): void {
  const lines = [
    "# Phronia adoption report",
    "",
    `- From: ${report.fromVersion ?? "unknown"}`,
    `- To: ${VERSION}`,
    `- Backup: ${report.backupDir ?? "(dry run)"}`,
    `- Platforms: ${report.platforms.join(", ") || "(none detected)"}`,
    "",
    "## Dropped (regenerated from templates)",
    ...listOrNone(report.dropped),
    "",
    "## Kept (no longer managed)",
    ...listOrNone(report.kept),
    "",
    "## Needs review",
    "Local edits were preserved as `<path>.pre-adopt` where a generated path conflicted.",
    ...listOrNone(report.needsReview),
    "",
    "## Warnings",
    ...listOrNone(report.warnings),
    "",
  ];
  fs.writeFileSync(path.join(currentDir, "adopt-report.md"), lines.join("\n"), "utf8");
}

function listOrNone(items: readonly string[]): string[] {
  return items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function printAdoptReport(report: AdoptReport): void {
  const prefix = report.dryRun ? "[dry run] " : "";
  process.stdout.write(
    `${prefix}${chalk.cyan("Phronia adopt")}: ${report.legacyDir}/ -> ${report.currentDir}/\n`,
  );
  if (report.fromVersion) {
    process.stdout.write(`  From version: ${report.fromVersion}\n`);
  }
  process.stdout.write(
    `  Platforms: ${report.platforms.join(", ") || "(none detected)"}\n`,
  );
  if (report.backupDir) {
    process.stdout.write(`  Backup: ${report.backupDir}\n`);
  }
  process.stdout.write(
    `  Dropped: ${report.dropped.length}, kept: ${report.kept.length}, needs review: ${report.needsReview.length}\n`,
  );
  for (const warning of report.warnings) {
    process.stderr.write(chalk.yellow(`  warning: ${warning}\n`));
  }
  if (report.needsReview.length > 0) {
    process.stdout.write(
      "  Review `.phronia/adopt-report.md`; local edits end in `.pre-adopt`.\n",
    );
  }
}
