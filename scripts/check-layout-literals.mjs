#!/usr/bin/env node
/**
 * Layout literal ratchet.
 *
 * B1 moves every workflow-path literal to `WorkspaceLayout`. That is a large
 * mechanical sweep, so the guard is a ratchet: a file may have fewer literals
 * than the recorded baseline, never more. Run with `--write-baseline` after an
 * intentional reduction.
 *
 * Counted roots:
 *   packages/cli/src/**  (.ts, .js, .py)
 *   packages/core/src/** (.ts)
 *
 * Excluded:
 *   packages/cli/src/constants/paths.ts   (the compatibility adapter)
 *   packages/cli/src/migrations/manifests (historical contracts, archived in B1/T7)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASELINE_PATH = path.join(
  REPO_ROOT,
  "packages/testing/baselines/layout-literals.json",
);
const ROOTS = ["packages/cli/src", "packages/core/src"];
const EXTENSIONS = new Set([".ts", ".js", ".py"]);
const EXCLUDED_FILES = new Set(["packages/cli/src/constants/paths.ts"]);
const EXCLUDED_DIRS = ["packages/cli/src/migrations/manifests"];
const PATTERN = /\.trellis\b/g;

function walk(relativeDir, out) {
  const absolute = path.join(REPO_ROOT, relativeDir);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.some((dir) => relative === dir || relative.startsWith(`${dir}/`))) {
        continue;
      }
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      walk(relative, out);
      continue;
    }
    if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    if (EXCLUDED_FILES.has(relative)) {
      continue;
    }
    const content = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    const matches = content.match(PATTERN);
    if (matches && matches.length > 0) {
      out[relative.replaceAll(path.sep, "/")] = matches.length;
    }
  }
}

function collect() {
  const counts = {};
  for (const root of ROOTS) {
    walk(root, counts);
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const counts = collect();
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const writeBaseline = process.argv.includes("--write-baseline");

  if (writeBaseline) {
    mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          version: 1,
          recordedAt: new Date().toISOString().slice(0, 10),
          total,
          files: counts,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stdout.write(`Wrote ${path.relative(REPO_ROOT, BASELINE_PATH)} (total=${total})\n`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const regressions = [];
  const reductions = [];

  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.files[file] ?? 0;
    if (count > allowed) {
      regressions.push({ file, allowed, count });
    } else if (count < allowed) {
      reductions.push({ file, allowed, count });
    }
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    if (!(file in counts)) {
      reductions.push({ file, allowed, count: 0 });
    }
  }

  for (const reduction of reductions) {
    process.stdout.write(
      `reduced ${reduction.file}: ${reduction.allowed} -> ${reduction.count}\n`,
    );
  }
  if (regressions.length > 0) {
    process.stderr.write("New .trellis literals were introduced:\n");
    for (const regression of regressions) {
      process.stderr.write(
        `  ${regression.file}: ${regression.allowed} -> ${regression.count}\n`,
      );
    }
    process.stderr.write(
      "Use WorkspaceLayout/projectPath() instead, or run --write-baseline only after an intentional change.\n",
    );
    process.exit(1);
  }

  process.stdout.write(`layout literal ratchet ok (total=${total})\n`);
}

main();
