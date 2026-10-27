/**
 * Resolve a bundled asset directory.
 *
 * In a normal install the templates sit next to the compiled module. In a
 * self-contained binary the runtime extracts them to a cache directory and
 * sets PHRONIA_ASSET_ROOT before importing the CLI.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function assetDir(importMetaUrl: string, subdir: string): string {
  const root = process.env.PHRONIA_ASSET_ROOT;
  if (root) {
    return subdir ? join(root, subdir) : root;
  }
  return dirname(fileURLToPath(importMetaUrl));
}
