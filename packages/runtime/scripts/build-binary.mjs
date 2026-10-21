#!/usr/bin/env node
/**
 * Cross-compile the native binary.
 *
 * Requires Bun (preferred) or Deno. Neither is a repository dependency; CI
 * installs one of them. The script refuses to guess so a missing toolchain is
 * never reported as a successful release.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "src/main.ts");
const dist = resolve(root, "dist");
const targets = [
  ["bun-darwin-arm64", "phronia-darwin-arm64"],
  ["bun-darwin-x64", "phronia-darwin-x64"],
  ["bun-linux-arm64", "phronia-linux-arm64"],
  ["bun-linux-x64", "phronia-linux-x64"],
  ["bun-windows-x64", "phronia-win-x64.exe"],
];

mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [resolve(root, "scripts/build-assets.mjs")], { stdio: "inherit" });

function has(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (has("bun")) {
  for (const [target, name] of targets) {
    execFileSync(
      "bun",
      ["build", "--compile", `--target=${target}`, entry, "--outfile", resolve(dist, name)],
      { stdio: "inherit" },
    );
  }
  process.exit(0);
}

if (has("deno")) {
  for (const name of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"]) {
    const out = resolve(dist, name.startsWith("windows") ? `phronia-${name}.exe` : `phronia-${name}`);
    execFileSync(
      "deno",
      ["compile", "--allow-read", "--allow-write", "--allow-run", "--allow-env", "--allow-net", "--output", out, entry],
      { stdio: "inherit" },
    );
  }
  process.exit(0);
}

console.error(
  "No Bun or Deno found. Install one in CI (see docs/release/b10-external-inputs.md);\n" +
    "the JS fallback can still be built with scripts/build-js-bundle.mjs.",
);
process.exit(2);
