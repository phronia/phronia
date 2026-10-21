#!/usr/bin/env node
/**
 * B1/T5 identifier codemod: skill/agent/command/branch prefixes.
 *
 * Order matters. The broad `trellis-` -> `phronia-` pass runs last; the
 * third-party ZCode plugin name `trellis-bridge` is restored afterwards
 * because Phronia does not own that product.
 *
 * Historical material and user data are excluded.
 *
 * Usage: node scripts/rename-identifiers.mjs [--apply]
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
  ".phronia/.backup-",
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
  ".hook",
]);

const REPLACEMENTS = [
  ["commands/trellis/", "commands/phronia/"],
  ["/trellis:", "/phronia:"],
  ["/skill trellis-", "/skill phronia-"],
  ["/skill:trellis-", "/skill:phronia-"],
  ["TRELLIS:START", "PHRONIA:START"],
  ["TRELLIS:END", "PHRONIA:END"],
  // Broad prefix pass.
  ["trellis-", "phronia-"],
  // Third-party product name: Phronia does not own it.
  ["phronia-bridge", "trellis-bridge"],
];

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
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".kiro.hook")) {
      continue;
    }

    const absolute = path.join(REPO_ROOT, relative);
    const content = readFileSync(absolute, "utf8");
    let next = content;
    let count = 0;
    for (const [from, to] of REPLACEMENTS) {
      if (!next.includes(from)) continue;
      const occurrences = next.split(from).length - 1;
      count += occurrences;
      next = next.split(from).join(to);
    }
    if (next === content) continue;
    total += count;
    changed.push({ relative, count });
    if (APPLY) writeFileSync(absolute, next, "utf8");
  }
}

walk("");
changed.sort((a, b) => b.count - a.count || a.relative.localeCompare(b.relative));
for (const item of changed.slice(0, 40)) {
  process.stdout.write(`${String(item.count).padStart(5)}  ${item.relative}\n`);
}
if (changed.length > 40) {
  process.stdout.write(`... and ${changed.length - 40} more files\n`);
}
process.stdout.write(
  `\n${APPLY ? "Applied" : "Would change"} ${total} occurrences in ${changed.length} files\n`,
);
