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

export interface ResolvedAdapter {
  adapterId: string;
  status: AdapterStatus;
  harnessVersion: string | null;
  reason: string;
  source: "pin" | "probe" | "recorded" | "fallback";
  detection: DetectionResult;
  fallback: string;
}

export interface ResolveAdapterOptions {
  /** Skip the `--version` probe (tests, offline installs). */
  probe?: boolean;
}

export function resolveAdapter(
  cwd: string,
  platform: PlatformId,
  options: ResolveAdapterOptions = {},
): ResolvedAdapter {
  const manifest = readAdapterManifest(cwd);
  const recorded = manifest.platforms[platform]?.adapterId ?? null;
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
      ? "recorded"
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
