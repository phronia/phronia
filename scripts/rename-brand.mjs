#!/usr/bin/env node
/**
 * B1/T9 brand codemod for documentation and template prose.
 *
 * Only markdown is touched. TypeScript identifiers (`getTrellisTemplatePath`,
 * `TrellisTaskRecord`) are intentionally out of scope. Upstream attribution
 * lines are protected so NOTICE/AGPL provenance stays accurate.
 *
 * Usage: node scripts/rename-brand.mjs [--apply]
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
  "packages/cli/src/migrations/",
  "docs/adr/",
  "docs/legal/",
  "packages/testing/baselines/",
  "scripts/",
  "bench/",
  ".phronia/tasks/",
  ".phronia/workspace/",
  ".phronia/spec/",
  ".phronia/.runtime/",
  ".phronia/.backup-",
];

const TARGET_FILES = new Set([
  "README.md",
  "README_CN.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING_CN.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/migrations/user-visible-changes.md",
]);

const PROTECTED = [
  "trellis-bridge",
  "mindfold-ai/Trellis",
  "mindfold-ai/trellis",
  "github.com/mindfold-ai/trellis",
  "github.com/mindfold-ai/Trellis",
];

const PROTECT_PREFIX = "\u0000PROTECTED";

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

function isTarget(relative) {
  if (TARGET_FILES.has(relative)) {
    return true;
  }
  return (
    relative.startsWith("packages/cli/src/templates/") &&
    (relative.endsWith(".md") || relative.endsWith(".md.txt"))
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
    if (!entry.isFile() || !isTarget(relative)) continue;

    const absolute = path.join(REPO_ROOT, relative);
    const before = readFileSync(absolute, "utf8");
    let next = before;
    const protectedValues = new Map();
    PROTECTED.forEach((token, index) => {
      const placeholder = `${PROTECT_PREFIX}${index}\u0000`;
      protectedValues.set(placeholder, token);
      next = next.split(token).join(placeholder);
    });

    next = next.replace(/\bTrellis\b/g, "Phronia");
    next = next.replace(/\btrellis\b/g, "phronia");
    next = next.replace(/\bTRELLIS\b/g, "PHRONIA");

    for (const [placeholder, token] of protectedValues) {
      next = next.split(placeholder).join(token);
    }

    if (next === before) continue;
    total += 1;
    changed.push(relative);
    if (APPLY) writeFileSync(absolute, next, "utf8");
  }
}

walk("");
for (const file of changed) process.stdout.write(`${file}\n`);
process.stdout.write(
  `\n${APPLY ? "Applied" : "Would change"} ${total} files\n`,
);
