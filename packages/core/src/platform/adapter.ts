/**
 * Harness adapter identity and state.
 *
 * A platform is a product; an adapter is one harness API generation. Four
 * values identify the runtime: platform, adapterId, harnessVersion, and the
 * Phronia shim version. Version uncertainty is explicit (`unknown`), never
 * guessed, so a wrong shard cannot be selected silently.
 */

import type { ContextEvent } from "../context/types.js";
import type { BehaviorBindings } from "./capabilities.js";
import type { PlatformId } from "./ids.js";

export interface AdapterIdentity {
  platform: PlatformId;
  /** `<platform>@v<major>`, keyed on the harness API generation. */
  adapterId: string;
  /** Detected harness version, or null when detection failed. */
  harnessVersion: string | null;
  /** Phronia package version that produced the shim. */
  shimVersion: string;
}

export type DetectionSource =
  | "cli"
  | "config-pin"
  | "runtime"
  | "recorded"
  | "none";

export type DetectionConfidence = "high" | "medium" | "low";

export interface DetectionResult {
  status: "detected" | "unknown" | "unsupported";
  harnessVersion: string | null;
  source: DetectionSource;
  confidence: DetectionConfidence;
  reason?: string;
}

export interface ShimHandshake {
  adapterId: string;
  apiVersion: string;
  supportedEvents: readonly string[];
}

export interface HarnessAdapter {
  readonly id: string;
  readonly platform: PlatformId;
  /** Supported harness range; null means "no version constraint". */
  readonly harnessRange: string | null;
  /** Selectable when the harness version cannot be detected. */
  readonly fallback?: boolean;
  readonly envelopes: Readonly<Partial<Record<ContextEvent, string>>>;
  readonly capabilityOverrides?: Partial<BehaviorBindings>;
  detect(context: DetectContext): DetectionResult;
  handshake(): ShimHandshake;
}

export interface DetectContext {
  platform: PlatformId;
  /** Runs `<command> --version`; injected so tests never spawn processes. */
  runCommand: (command: string, args: readonly string[]) => string | null;
}

export type AdapterStatus =
  | "ok"
  | "degraded"
  | "unsupported"
  | "partial"
  | "schema-drift";

export interface AdapterState {
  status: AdapterStatus;
  adapter: HarnessAdapter | null;
  fallback: "prelude" | "skills" | "none";
  reason: string;
  userMessage: string | null;
}

export interface AdapterSelection {
  adapter: HarnessAdapter | null;
  status: AdapterStatus;
  reason: string;
  detection: DetectionResult;
  fallback: AdapterState["fallback"];
}
