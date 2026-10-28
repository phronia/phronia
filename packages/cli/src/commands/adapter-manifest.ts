/**
 * Write `.phronia/manifest.json` from the current detection result.
 *
 * init/update/doctor own this file. Hooks only write per-platform handshake
 * files, so a hook that fires during an update cannot race the manifest.
 */

import {
  CORE_VERSION,
  nodeFs,
  probeHarnessVersion,
  readAdapterManifest,
  readConfig,
  recordPlatform,
  selectAdapter,
  writeAdapterManifest,
  type AdapterStatus,
  type DetectionResult,
  type PlatformId,
} from "@phronia/core";
import { getConfiguredPlatforms } from "../configurators/index.js";

export interface RefreshedPlatform {
  id: PlatformId;
  adapterId: string | null;
  harnessVersion: string | null;
  source: string;
  status: AdapterStatus;
  reason: string;
  fallback: string;
}

export function refreshAdapterManifest(
  cwd: string,
  options: { platforms?: readonly PlatformId[]; probe?: boolean } = {},
): RefreshedPlatform[] {
  const ids =
    options.platforms ??
    ([...getConfiguredPlatforms(cwd)].sort() as PlatformId[]);
  if (ids.length === 0) return [];

  let manifest = readAdapterManifest(cwd);
  const recorded = manifest.platforms;
  const pins = readConfig(cwd, nodeFs).value.adapterPins;
  const detectedAt = new Date().toISOString();
  const results: RefreshedPlatform[] = [];

  for (const id of ids) {
    const detection: DetectionResult =
      options.probe === false
        ? {
            status: "unknown",
            harnessVersion: null,
            source: "none",
            confidence: "low",
            reason: "probing disabled",
          }
        : probeHarnessVersion(id);
    const selection = selectAdapter({
      platform: id,
      detection,
      pin: pins[id] ?? null,
      recorded: recorded[id]?.adapterId ?? null,
    });
    manifest = recordPlatform(manifest, id, {
      adapterId: selection.adapter?.id ?? `${id}@v1`,
      harnessVersion: detection.harnessVersion,
      harnessVersionSource: detection.source,
      confidence: detection.confidence,
      shimVersion: CORE_VERSION,
      status: selection.status,
      reason: selection.reason,
      fallback: selection.fallback,
      detectedAt,
      lastHandshakeAt: null,
      lastHandshakeEvent: null,
    });
    results.push({
      id,
      adapterId: selection.adapter?.id ?? null,
      harnessVersion: detection.harnessVersion,
      source: detection.source,
      status: selection.status,
      reason: selection.reason,
      fallback: selection.fallback,
    });
  }

  writeAdapterManifest(cwd, manifest);
  return results;
}
