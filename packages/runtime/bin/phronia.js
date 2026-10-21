#!/usr/bin/env node
/**
 * npm launcher: prefer the platform binary, then PHRONIA_BINARY, then the JS
 * bundle. Never download at install time (restricted networks fail there).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? ".exe" : "";
const candidates = [
  process.env.PHRONIA_BINARY,
  join(here, "..", "..", `cli-${platform}`, "bin", `phronia${exe}`),
  join(here, "..", "dist", `phronia-${platform}${exe}`),
];

for (const candidate of candidates) {
  if (candidate && existsSync(candidate)) {
    const result = spawnSync(candidate, process.argv.slice(2), { stdio: "inherit" });
    process.exit(result.status ?? 0);
  }
}

const bundle = join(here, "..", "dist", "phronia.mjs");
if (existsSync(bundle)) {
  await import(pathToFileURL(bundle).href);
  process.exit(0);
}

console.error(
  `phronia: no binary for ${platform} and no JS fallback at ${bundle}.\n` +
    "Install the matching @phronia/cli-* package, or build the bundle with `pnpm --filter @phronia/runtime build:bundle`.",
);
process.exit(1);
