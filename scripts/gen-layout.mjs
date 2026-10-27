#!/usr/bin/env node
/**
 * Generate the Python-visible layout from the TypeScript source of truth.
 *
 * `packages/core/src/layout/index.ts` is authoritative. Python scripts cannot
 * import TypeScript, so they read a generated JSON file next to `paths.py`.
 * CI runs this script and fails if the committed JSON differs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORE_LAYOUT = path.join(REPO_ROOT, "packages/core/dist/layout/index.js");
const TARGET = path.join(
  REPO_ROOT,
  "packages/cli/src/templates/workflow/scripts/common/layout.json",
);
const CHECK = process.argv.includes("--check");

async function main() {
  let module;
  try {
    module = await import(pathToFileURL(CORE_LAYOUT).href);
  } catch (error) {
    process.stderr.write(
      `Cannot load ${CORE_LAYOUT}. Run \`pnpm build:core\` first.\n${String(error)}\n`,
    );
    process.exit(1);
  }

  const layout = module.LAYOUT;
  if (!layout || typeof layout !== "object") {
    process.stderr.write("Core layout module did not export LAYOUT.\n");
    process.exit(1);
  }

  const payload = {
    schemaVersion: 1,
    rootDirName: layout.rootDirName,
    brand: layout.brand,
    packageScope: layout.packageScope,
    envPrefix: layout.envPrefix,
    legacyRootDirName: layout.legacyRootDirName,
    paths: layout.paths,
  };

  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (CHECK) {
    let current = "";
    try {
      current = readFileSync(TARGET, "utf8");
    } catch {
      current = "";
    }
    if (current !== content) {
      process.stderr.write(
        `${path.relative(REPO_ROOT, TARGET)} is stale. Run \`pnpm gen:layout\`.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`layout.json is current\n`);
    return;
  }

  writeFileSync(TARGET, content, "utf8");
  process.stdout.write(`Wrote ${path.relative(REPO_ROOT, TARGET)}\n`);
}

main();
