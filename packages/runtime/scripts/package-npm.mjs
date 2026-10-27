#!/usr/bin/env node
/**
 * Assemble the npm publish staging tree.
 *
 * The source package.json deliberately omits optionalDependencies so a local
 * `pnpm install` never tries to fetch unpublished platform packages. This
 * script injects them into the staged manifest, where npm actually reads them.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "../cli");
const dist = resolve(root, "dist");
const out = resolve(dist, "npm");
const cliPkg = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
const version = cliPkg.version;

const TARGETS = [
  { dir: "darwin-arm64", pkg: "@phronia/cli-darwin-arm64", os: "darwin", cpu: "arm64", bin: "phronia-darwin-arm64", file: "phronia" },
  { dir: "darwin-x64", pkg: "@phronia/cli-darwin-x64", os: "darwin", cpu: "x64", bin: "phronia-darwin-x64", file: "phronia" },
  { dir: "linux-arm64", pkg: "@phronia/cli-linux-arm64", os: "linux", cpu: "arm64", bin: "phronia-linux-arm64", file: "phronia" },
  { dir: "linux-x64", pkg: "@phronia/cli-linux-x64", os: "linux", cpu: "x64", bin: "phronia-linux-x64", file: "phronia" },
  { dir: "win32-x64", pkg: "@phronia/cli-win32-x64", os: "win32", cpu: "x64", bin: "phronia-win-x64.exe", file: "phronia.exe" },
];

mkdirSync(out, { recursive: true });
const optionalDependencies = {};

for (const target of TARGETS) {
  const source = join(dist, target.bin);
  if (!existsSync(source)) {
    console.error(`missing binary: ${source}`);
    process.exit(1);
  }
  const pkgDir = join(out, target.pkg);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  cpSync(source, join(pkgDir, "bin", target.file));
  writeFileSync(
    join(pkgDir, "package.json"),
    `${JSON.stringify(
      {
        name: target.pkg,
        version,
        description: `Phronia CLI binary for ${target.os}/${target.cpu}`,
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin"],
        license: cliPkg.license ?? "AGPL-3.0-only",
        repository: cliPkg.repository,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  optionalDependencies[target.pkg] = version;
}

const mainDir = join(out, cliPkg.name);
mkdirSync(mainDir, { recursive: true });
const { optionalDependencies: _ignored, ...base } = cliPkg;
writeFileSync(
  join(mainDir, "package.json"),
  `${JSON.stringify({ ...base, bin: { phronia: "./bin/phronia.js" }, optionalDependencies }, null, 2)}\n`,
  "utf8",
);
for (const item of ["bin", "dist"]) {
  const source = join(cli, item);
  if (existsSync(source)) cpSync(source, join(mainDir, item), { recursive: true });
}
for (const item of ["README.md", "LICENSE"]) {
  const source = join(cli, item);
  if (existsSync(source)) cpSync(source, join(mainDir, item));
}
// The npm launcher looks for sibling @phronia/cli-* packages.
cpSync(join(root, "bin/phronia.js"), join(mainDir, "bin/phronia.js"));

console.log(`staged ${readdirSync(out).length} package(s) in ${out}`);
