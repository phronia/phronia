#!/usr/bin/env node
/**
 * Build single-file shim artifacts.
 *
 * Each adapter shard is bundled independently. The header carries the adapter
 * id, Phronia version, build id, and a content hash computed over the body, so
 * `update` can classify the installed file. The v2 shim is deliberately
 * dependency-free at runtime: `@opencode/plugin` is only a development-time
 * type source, so the bundle imports nothing from it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "packages/cli/src/templates");
const SHIM_VERSION = JSON.parse(
  readFileSync(resolve(ROOT, "packages/cli/package.json"), "utf8"),
).version;
const CHECK = process.argv.includes("--check");

const SHARDS = [
  {
    adapterId: "opencode@v1",
    out: "v1",
    entries: [
      ["session-start.js", "opencode/adapters/v1/plugins/session-start.js"],
      ["inject-workflow-state.js", "opencode/adapters/v1/plugins/inject-workflow-state.js"],
      ["inject-subagent-context.js", "opencode/adapters/v1/plugins/inject-subagent-context.js"],
    ],
    inputs: [
      "opencode/adapters/v1/lib/debug.js",
      "opencode/adapters/v1/lib/phronia-client.js",
      "opencode/adapters/v1/lib/context-visibility.js",
      "opencode/adapters/v1/lib/session-utils.js",
    ],
  },
  {
    adapterId: "opencode@v2",
    out: "v2",
    entries: [["phronia.js", "opencode/adapters/v2/plugin.js"]],
    inputs: [
      "opencode/adapters/v2/lib/debug.js",
      "opencode/adapters/v2/lib/phronia-client.js",
    ],
  },
];

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error("esbuild is required for build:shims (pnpm add -Dw esbuild@0.27.3)");
  process.exit(2);
}

function buildId() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch) return `epoch-${epoch}`;
  // Hash the inputs, not the commit: a commit id cannot be embedded in an
  // artifact that is itself committed (the id changes after the commit).
  const hash = createHash("sha256");
  for (const shard of SHARDS) {
    for (const [entry, source] of shard.entries) {
      hash.update(`${shard.adapterId}\n${entry}\n`);
      hash.update(readFileSync(resolve(CLI, source)));
    }
    for (const source of shard.inputs) {
      try {
        hash.update(`${shard.adapterId}\n${source}\n`);
        hash.update(readFileSync(resolve(CLI, source)));
      } catch {
        // optional module
      }
    }
  }
  hash.update(SHIM_VERSION);
  return hash.digest("hex").slice(0, 12);
}

const build = buildId();

function formatArtifact(body, adapterId) {
  const hash = createHash("sha256").update(body).digest("hex");
  const header = [
    `// phronia-shim: ${adapterId}`,
    `// shim-version: ${SHIM_VERSION}`,
    `// build-id: ${build}`,
    `// content-hash: ${hash}`,
    "// DO NOT EDIT. Regenerate with: pnpm build:shims",
    "",
  ].join("\n");
  return `${header}\n${body}`;
}

let changed = 0;
const artifacts = [];
for (const shard of SHARDS) {
  const outDir = resolve(CLI, "_generated/shims", shard.out);
  for (const [entry, source] of shard.entries) {
    const result = await esbuild.build({
      entryPoints: [resolve(CLI, source)],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: ["node20"],
      legalComments: "none",
      banner: {
        js: 'import { createRequire as __phroniaCreateRequire } from "node:module"; const require = __phroniaCreateRequire(import.meta.url);',
      },
    });
    const body = result.outputFiles?.[0]?.text ?? "";
    if (!body) throw new Error(`empty bundle for ${shard.adapterId}/${entry}`);
    const artifact = formatArtifact(body, shard.adapterId);
    artifacts.push({
      path: `${shard.out}/${entry}`,
      adapterId: shard.adapterId,
      shimVersion: SHIM_VERSION,
      buildId: build,
      sha256: createHash("sha256").update(body).digest("hex"),
      lines: artifact.split("\n").length,
    });
    const target = resolve(outDir, entry);
    const existing = (() => {
      try {
        return readFileSync(target, "utf8");
      } catch {
        return "";
      }
    })();
    if (existing === artifact) continue;
    changed += 1;
    if (CHECK) {
      console.error(`stale shim artifact: ${relative(ROOT, target)}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact, "utf8");
  }
}

const manifest = {
  schemaVersion: 1,
  coreVersion: SHIM_VERSION,
  buildId: build,
  artifacts,
};
const manifestPath = resolve(CLI, "_generated/shims/manifest.json");
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const existingManifest = (() => {
  try {
    return readFileSync(manifestPath, "utf8");
  } catch {
    return "";
  }
})();
if (existingManifest !== manifestText) {
  changed += 1;
  if (CHECK) {
    console.error("stale shim artifact: packages/cli/src/templates/_generated/shims/manifest.json");
  } else {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, manifestText, "utf8");
  }
}

if (CHECK && changed > 0) {
  console.error(`build:shims --check found ${changed} stale artifact(s)`);
  process.exit(1);
}
console.log(
  CHECK
    ? "shim artifacts are current"
    : `shim artifacts written (${changed} changed, build ${build})`,
);
