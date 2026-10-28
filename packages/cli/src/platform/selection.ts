/**
 * Installation-time adapter selection.
 *
 * Core's `selectAdapter` decides which generation matches a detected version.
 * This module adds the inputs only the CLI has: the config pin, the adapter
 * recorded by the last install, and whether this machine can probe the
 * harness at all.
 *
 * Precedence: pin > successful probe > recorded > fallback. A successful
 * probe must win over the recorded value, otherwise upgrading the harness
 * would keep writing the previous generation. The recorded value exists so a
 * machine without the harness installed does not rewrite a shared repo's shard.
 */

import {
  nodeFs,
  probeHarnessVersion,
  readAdapterManifest,
  readConfig,
  selectAdapter,
  type AdapterStatus,
  type DetectionResult,
  type PlatformId,
} from "@phronia/core";
import { loadHashes } from "../utils/template-hash.js";

export interface ResolvedAdapter {
  adapterId: string;
  status: AdapterStatus;
  harnessVersion: string | null;
  reason: string;
  source: "pin" | "probe" | "recorded" | "installed" | "fallback";
  detection: DetectionResult;
  fallback: string;
}

export interface ResolveAdapterOptions {
  /** Skip the `--version` probe (tests, offline installs). */
  probe?: boolean;
}

/**
 * The adapter manifest is machine-local (gitignored), so a fresh clone or CI
 * has no recorded value. The installed shard is still evidence: if the project
 * tracks the v2 plugin, resolving to v1 would make `update --dry-run` report a
 * migration that the committed tree does not have.
 */
function inferInstalledAdapter(cwd: string, platform: PlatformId): string | null {
  if (platform !== "opencode") return null;
  const hashes = loadHashes(cwd);
  if (hashes[".opencode/plugins/phronia.js"]) return "opencode@v2";
  if (hashes[".opencode/plugins/session-start.js"]) return "opencode@v1";
  return null;
}

export function resolveAdapter(
  cwd: string,
  platform: PlatformId,
  options: ResolveAdapterOptions = {},
): ResolvedAdapter {
  const manifest = readAdapterManifest(cwd);
  const manifestRecorded = manifest.platforms[platform]?.adapterId ?? null;
  const inferred = manifestRecorded
    ? null
    : inferInstalledAdapter(cwd, platform);
  const recorded = manifestRecorded ?? inferred;
  const pin = readConfig(cwd, nodeFs).value.adapterPins[platform] ?? null;
  const detection: DetectionResult =
    options.probe === false
      ? {
          status: "unknown",
          harnessVersion: null,
          source: "none",
          confidence: "low",
          reason: "probing disabled",
        }
      : probeHarnessVersion(platform);

  const selection = selectAdapter({ platform, detection, pin, recorded });
  const adapterId =
    selection.adapter?.id ??
    recorded ??
    (platform === "opencode" ? "opencode@v1" : `${platform}@v1`);

  const source: ResolvedAdapter["source"] = pin
    ? "pin"
    : selection.reason === "recorded-adapter"
      ? manifestRecorded
        ? "recorded"
        : "installed"
      : detection.status === "detected"
        ? "probe"
        : "fallback";

  return {
    adapterId,
    status: selection.status,
    harnessVersion: detection.harnessVersion,
    reason: selection.reason,
    source,
    detection,
    fallback: selection.fallback,
  };
}
