/**
 * Reconcile generation-owned files when a platform switches adapter shards.
 *
 * Only files that are (a) owned by a retired shard, (b) tracked in
 * `.template-hashes.json`, and (c) still byte-identical to the tracked hash
 * are removed. A user-modified file stays on disk and is reported.
 *
 * `.opencode/package.json` is deliberately kept: it is harmless on v2 and
 * other local plugins in the same directory may still resolve through it.
 */

import fs from "node:fs";
import path from "node:path";
import {
  OPENCODE_V1,
  OPENCODE_V2,
  openCodeShardOwnedPaths,
  type OpenCodeAdapterId,
} from "./opencode.js";
import { computeHash, loadHashes, removeHash } from "../utils/template-hash.js";
import { toPosix } from "../utils/posix.js";

export interface AdapterReconcileResult {
  removed: string[];
  kept: string[];
}

export interface AdapterReconcileOptions {
  cwd: string;
  /** Paths the selected adapter owns (already-rendered project-relative paths). */
  currentOwned: readonly string[];
  /** Paths every retired shard owned. */
  retiredOwned: readonly string[];
  /** Paths the new template set still writes. */
  desired: ReadonlySet<string>;
  /** Paths that must never be deleted automatically. */
  protectedPaths?: readonly string[];
}

export function reconcileAdapterFiles(
  options: AdapterReconcileOptions,
): AdapterReconcileResult {
  const result: AdapterReconcileResult = { removed: [], kept: [] };
  const current = new Set(options.currentOwned.map(toPosix));
  const protectedPaths = new Set((options.protectedPaths ?? []).map(toPosix));
  const hashes = loadHashes(options.cwd);

  for (const rawPath of options.retiredOwned) {
    const relativePath = toPosix(rawPath);
    if (current.has(relativePath)) continue;
    if (options.desired.has(relativePath)) continue;

    const absolute = path.join(options.cwd, ...relativePath.split("/"));
    if (!fs.existsSync(absolute)) {
      if (hashes[relativePath] !== undefined) removeHash(options.cwd, relativePath);
      continue;
    }

    if (protectedPaths.has(relativePath)) {
      result.kept.push(relativePath);
      continue;
    }

    const tracked = hashes[relativePath];
    if (tracked === undefined) {
      // Not written by Phronia; never delete.
      continue;
    }
    const currentHash = computeHash(fs.readFileSync(absolute, "utf-8"));
    if (currentHash !== tracked) {
      result.kept.push(relativePath);
      continue;
    }
    fs.unlinkSync(absolute);
    removeHash(options.cwd, relativePath);
    result.removed.push(relativePath);
  }

  return result;
}

/**
 * OpenCode-specific entry point: retire the other generation's files while
 * keeping the shared base (agents/commands/skills) and any user edits.
 */
export function reconcileOpenCodeAdapter(
  cwd: string,
  adapterId: OpenCodeAdapterId,
  desired: ReadonlySet<string>,
): AdapterReconcileResult {
  const result = reconcileAdapterFiles({
    cwd,
    currentOwned: openCodeShardOwnedPaths(adapterId),
    retiredOwned: [
      ...openCodeShardOwnedPaths(OPENCODE_V1),
      ...openCodeShardOwnedPaths(OPENCODE_V2),
    ],
    desired,
    // Keeping this file is harmless on v2 and may still resolve dependencies
    // for other local plugins the user added to `.opencode/plugins/`.
    protectedPaths: [".opencode/package.json"],
  });
  // v2 does not manage this file. Keeping it on disk is safe, but leaving a
  // tracked hash would make every later update treat it as a deleted template.
  removeHash(cwd, ".opencode/package.json");
  return result;
}
