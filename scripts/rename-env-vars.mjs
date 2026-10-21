#!/usr/bin/env node
/**
 * B1/T4 env-var codemod: TRELLIS_* -> PHRONIA_*.
 *
 * Historical and user-owned material is excluded. Legacy names keep working
 * through the alias installers added in the same commit
 * (packages/cli/src/cli/env-compat.ts and scripts/common/__init__.py).
 *
 * Usage: node scripts/rename-env-vars.mjs [--apply]
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
  ".phronia/tasks/",
  ".phronia/workspace/",
  ".phronia/spec/",
  ".phronia/.runtime/",
];

const EXCLUDE_FILES = new Set(["NOTICE.md", "LICENSE", "COPYRIGHT", "pnpm-lock.yaml"]);

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
]);

const PATTERN = /\bTRELLIS_([A-Z0-9_]+)/g;
let total = 0;
const changed = [];

function shouldSkipDir(relative) {
  return (
    SKIP_DIRS.has(path.basename(relative)) ||
    EXCLUDE_PREFIXES.some(
      (prefix) => relative === prefix.slice(0, -1) || relative.startsWith(prefix),
    )
  );
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
      if (!shouldSkipDir(relative)) walk(relative);
      continue;
    }
    if (!entry.isFile() || EXCLUDE_FILES.has(relative)) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;

    const absolute = path.join(REPO_ROOT, relative);
    const content = readFileSync(absolute, "utf8");
    const matches = content.match(PATTERN);
    if (!matches) continue;
    total += matches.length;
    changed.push({ relative, count: matches.length });
    if (APPLY) {
      writeFileSync(absolute, content.replace(PATTERN, "PHRONIA_$1"), "utf8");
    }
  }
}

walk("");
changed.sort((a, b) => b.count - a.count || a.relative.localeCompare(b.relative));
for (const item of changed) {
  process.stdout.write(`${String(item.count).padStart(4)}  ${item.relative}\n`);
}
process.stdout.write(
  `\n${APPLY ? "Applied" : "Would change"} ${total} occurrences in ${changed.length} files\n`,
);
