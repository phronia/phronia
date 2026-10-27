/**
 * Runtime entrypoint for the self-contained binary.
 *
 * The CLI reads templates from disk, so the binary embeds them and extracts
 * to a cache directory once per asset hash before importing the CLI.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ASSET_BUILD_ID, ASSETS } from "./assets.generated.js";

const root = join(
  process.env.PHRONIA_RUNTIME_CACHE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "phronia", "runtime"),
  ASSET_BUILD_ID,
);
const marker = join(root, ".complete");

if (!existsSync(marker)) {
  for (const [relative, encoded] of Object.entries(ASSETS)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(encoded, "base64"));
  }
  writeFileSync(marker, ASSET_BUILD_ID, "utf8");
}
process.env.PHRONIA_ASSET_ROOT = root;

await import("../../cli/dist/cli/index.js");
