#!/usr/bin/env node
/**
 * B1/T4 package identity codemod.
 *
 * Renames the npm identity from `@mindfoldhq/trellis*` to `@phronia/*`.
 * Historical material (NOTICE, ADRs, legal log, migration manifests) keeps the
 * old names; user data under `.phronia/` is not rewritten.
 *
 * Usage: node scripts/rename-packages.mjs [--apply]
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

// Longest first: `@mindfoldhq/trellis-core` must not be consumed by the CLI
// pattern.
const REPLACEMENTS = [
  ["@mindfoldhq/trellis-core", "@phronia/core"],
  ["@mindfoldhq/trellis-testing", "@phronia/testing"],
  ["@mindfoldhq/trellis", "@phronia/cli"],
];

const changed = [];
let total = 0;

function shouldSkipDir(relative) {
  return (
    SKIP_DIRS.has(path.basename(relative)) ||
    EXCLUDE_PREFIXES.some((prefix) => relative === prefix.slice(0, -1) || relative.startsWith(prefix))
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
    let next = content;
    let count = 0;
    for (const [from, to] of REPLACEMENTS) {
      const pattern = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      const matches = next.match(pattern);
      if (matches) {
        count += matches.length;
        next = next.replace(pattern, to);
      }
    }
    if (count === 0) continue;
    total += count;
    changed.push({ relative, count });
    if (APPLY) writeFileSync(absolute, next, "utf8");
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
