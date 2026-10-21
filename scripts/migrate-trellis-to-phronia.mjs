#!/usr/bin/env node
/**
 * One-shot, reviewable codemod for B1/T3.
 *
 * Replaces the workflow-directory literal `.trellis` with `.phronia` across
 * product sources, templates, tests, and dogfood platform files.
 *
 * Deliberately excluded (historical or provenance material):
 *   - upstream migration manifests (archived later in B1/T7)
 *   - docs/adr and docs/legal (describe the migration itself)
 *   - NOTICE.md / LICENSE / COPYRIGHT
 *   - recorded baselines under packages/testing/baselines
 *   - this scripts/ directory
 *   - third-party submodules
 *
 * Usage:
 *   node scripts/migrate-trellis-to-phronia.mjs           # dry run
 *   node scripts/migrate-trellis-to-phronia.mjs --apply   # write files
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APPLY = process.argv.includes("--apply");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".zcode",
  "docs-site",
  "marketplace",
]);

const EXCLUDE_PREFIXES = [
  "packages/cli/src/migrations/manifests/",
  "docs/adr/",
  "docs/legal/",
  "packages/testing/baselines/",
  "scripts/",
  "bench/",
  // User and historical data: never rewrite content. The directory move keeps
  // these files intact; references inside them are history, not configuration.
  ".trellis/tasks/",
  ".trellis/workspace/",
  ".trellis/spec/",
  ".trellis/.runtime/",
];

const EXCLUDE_FILES = new Set([
  "NOTICE.md",
  "LICENSE",
  "COPYRIGHT",
  "pnpm-lock.yaml",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".md",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".txt",
  ".toml",
  ".sh",
  ".gitignore",
  ".gitattributes",
]);

const PATTERN = /\.trellis\b/g;
const REPLACEMENT = ".phronia";

const changed = [];
let total = 0;

function shouldSkipDir(relative) {
  if (SKIP_DIRS.has(path.basename(relative))) {
    return true;
  }
  return EXCLUDE_PREFIXES.some((prefix) => `${relative}/` === prefix || relative.startsWith(prefix));
}

function walk(relativeDir) {
  let entries;
  try {
    entries = readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(relative)) {
        walk(relative);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (EXCLUDE_FILES.has(relative)) {
      continue;
    }
    const extension = path.extname(entry.name);
    if (!TEXT_EXTENSIONS.has(extension) && !entry.name.startsWith(".git")) {
      continue;
    }
    const absolute = path.join(REPO_ROOT, relative);
    const content = readFileSync(absolute, "utf8");
    const matches = content.match(PATTERN);
    if (!matches) {
      continue;
    }
    total += matches.length;
    changed.push({ relative, count: matches.length });
    if (APPLY) {
      writeFileSync(absolute, content.replace(PATTERN, REPLACEMENT), "utf8");
    }
  }
}

walk("");

changed.sort((a, b) => b.count - a.count || a.relative.localeCompare(b.relative));
for (const item of changed) {
  process.stdout.write(`${String(item.count).padStart(5)}  ${item.relative}\n`);
}
process.stdout.write(
  `\n${APPLY ? "Applied" : "Would change"} ${total} occurrences in ${changed.length} files\n`,
);
if (!APPLY) {
  process.stdout.write("Re-run with --apply to write.\n");
}
