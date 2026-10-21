/**
 * Runtime adapter manifest and handshake files.
 *
 * `.template-hashes.json` records file ownership. This manifest records which
 * adapter the project believes it is running, and the handshake directory
 * records what the harness actually loaded. Hooks only write handshakes;
 * init/update/doctor own the manifest so concurrent hook runs never race.
 */

import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { CORE_VERSION } from "../version.js";
import type { AdapterStatus } from "./adapter.js";
import type { PlatformId } from "./ids.js";

export const ADAPTER_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface PlatformAdapterRecord {
  adapterId: string;
  harnessVersion: string | null;
  harnessVersionSource: string;
  confidence: string;
  shimVersion: string;
  status: AdapterStatus;
  reason?: string;
  fallback?: string | null;
  detectedAt: string;
  lastHandshakeAt?: string | null;
  lastHandshakeEvent?: string | null;
}

export interface AdapterManifest {
  schemaVersion: typeof ADAPTER_MANIFEST_SCHEMA_VERSION;
  phroniaVersion: string;
  generatedAt: string;
  platforms: Partial<Record<PlatformId, PlatformAdapterRecord>>;
}

export interface HandshakeRecord {
  platform: string;
  event: string;
  adapterId: string;
  shimVersion: string;
  observedPayloadKeys: string[];
  at: string;
}

export function manifestPath(root: string): string {
  return path.join(root, LAYOUT.paths.adapterManifest);
}

export function handshakePath(root: string, platform: string): string {
  return path.join(root, LAYOUT.paths.handshakes, `${platform}.json`);
}

export function readAdapterManifest(root: string): AdapterManifest {
  const empty: AdapterManifest = {
    schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
    phroniaVersion: CORE_VERSION,
    generatedAt: "",
    platforms: {},
  };
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(root), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return empty;
    const data = raw as Partial<AdapterManifest>;
    if (data.schemaVersion !== ADAPTER_MANIFEST_SCHEMA_VERSION) return empty;
    return {
      schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
      phroniaVersion:
        typeof data.phroniaVersion === "string" ? data.phroniaVersion : CORE_VERSION,
      generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
      platforms:
        data.platforms && typeof data.platforms === "object" ? data.platforms : {},
    };
  } catch {
    return empty;
  }
}

export function writeAdapterManifest(root: string, manifest: AdapterManifest): boolean {
  const target = manifestPath(root);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  return writeIfChanged(target, content);
}

export function recordPlatform(
  manifest: AdapterManifest,
  platform: PlatformId,
  record: PlatformAdapterRecord,
): AdapterManifest {
  return {
    ...manifest,
    phroniaVersion: CORE_VERSION,
    generatedAt: new Date().toISOString(),
    platforms: { ...manifest.platforms, [platform]: record },
  };
}

export function readHandshake(root: string, platform: string): HandshakeRecord | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(handshakePath(root, platform), "utf8"),
    ) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    if (typeof data.platform !== "string" || typeof data.event !== "string") {
      return null;
    }
    return {
      platform: data.platform,
      event: data.event,
      adapterId: typeof data.adapterId === "string" ? data.adapterId : "",
      shimVersion: typeof data.shimVersion === "string" ? data.shimVersion : "",
      observedPayloadKeys: Array.isArray(data.observedPayloadKeys)
        ? data.observedPayloadKeys.filter((key): key is string => typeof key === "string")
        : [],
      at: typeof data.at === "string" ? data.at : "",
    };
  } catch {
    return null;
  }
}

/**
 * Record that the harness actually invoked a shim. The payload *keys* are
 * stored, never their values, so session ids and prompts never leak.
 */
export function writeHandshake(
  root: string,
  platform: string,
  event: string,
  adapterId: string,
  payload: unknown,
): boolean {
  const target = handshakePath(root, platform);
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>).sort()
      : [];
  const existing = readHandshake(root, platform);
  if (
    existing?.platform === platform &&
    existing.event === event &&
    existing.adapterId === adapterId &&
    existing.observedPayloadKeys.join("\u0000") === keys.join("\u0000")
  ) {
    // Same adapter, same event shape: keep the original timestamp so doctor
    // can still tell when the harness first proved it invokes us.
    return false;
  }
  const record: HandshakeRecord = {
    platform,
    event,
    adapterId,
    shimVersion: CORE_VERSION,
    observedPayloadKeys: keys,
    at: new Date().toISOString(),
  };
  return writeIfChanged(target, `${JSON.stringify(record, null, 2)}\n`);
}

export function handshakeAgeMs(
  record: HandshakeRecord | null,
  now = Date.now(),
): number | null {
  if (!record?.at) return null;
  const at = Date.parse(record.at);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

function writeIfChanged(target: string, content: string): boolean {
  try {
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) {
      return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content, "utf8");
    fs.renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}
