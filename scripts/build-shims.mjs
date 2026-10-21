#!/usr/bin/env node
/**
 * Build single-file shim artifacts.
 *
 * OpenCode is the only shim with shared modules; bundling it proves the
 * artifact pipeline for the others (which are already single files). The
 * header carries the adapter id, Phronia version, build id, and a content
 * hash computed over the body, so `update` can classify the installed file.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "packages/cli/src/templates");
const OUT = resolve(CLI, "_generated/shims/opencode");
const SHIM_VERSION = JSON.parse(
  readFileSync(resolve(ROOT, "packages/cli/package.json"), "utf8"),
).version;
const CHECK = process.argv.includes("--check");

const ADAPTER = "opencode@v1";
const ENTRIES = [
  ["session-start.js", "session-start.js"],
  ["inject-workflow-state.js", "inject-workflow-state.js"],
  ["inject-subagent-context.js", "inject-subagent-context.js"],
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
  for (const [entry] of ENTRIES) {
    const file = resolve(CLI, "opencode/plugins", entry);
    hash.update(`${entry}\n`);
    hash.update(readFileSync(file));
  }
  for (const lib of ["lib/debug.js", "lib/phronia-client.js", "lib/context-visibility.js"]) {
    try {
      hash.update(`${lib}\n`);
      hash.update(readFileSync(resolve(CLI, "opencode", lib)));
    } catch {
      // optional module
    }
  }
  hash.update(SHIM_VERSION);
  return hash.digest("hex").slice(0, 12);
}

const build = buildId();

function formatArtifact(body) {
  const hash = createHash("sha256").update(body).digest("hex");
  const header = [
    `// phronia-shim: ${ADAPTER}`,
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
for (const [entry] of ENTRIES) {
  const result = await esbuild.build({
    entryPoints: [resolve(CLI, "opencode/plugins", entry)],
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
  if (!body) throw new Error(`empty bundle for ${entry}`);
  const artifact = formatArtifact(body);
  artifacts.push({
    path: `opencode/${entry}`,
    adapterId: ADAPTER,
    shimVersion: SHIM_VERSION,
    buildId: build,
    sha256: createHash("sha256").update(body).digest("hex"),
    lines: artifact.split("\n").length,
  });
  const target = resolve(OUT, entry);
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
