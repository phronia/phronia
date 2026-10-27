/**
 * Adapter registry and selection.
 *
 * One adapter per platform generation. OpenCode carries two shards so a
 * harness major upgrade selects v2 (and reports unsupported until it exists)
 * instead of silently reusing the v1 plugin.
 */

import type {
  AdapterSelection,
  DetectionResult,
  HarnessAdapter,
  HarnessAdapter as Adapter,
} from "./adapter.js";
import { PLATFORM_IDS, type PlatformId } from "./ids.js";
import { satisfiesRange } from "./semver.js";

function adapter(
  platform: PlatformId,
  options: {
    major?: number;
    harnessRange?: string | null;
    fallback?: boolean;
    unsupported?: string;
    envelopes?: HarnessAdapter["envelopes"];
  } = {},
): HarnessAdapter {
  const major = options.major ?? 1;
  return {
    id: `${platform}@v${major}`,
    platform,
    harnessRange: options.harnessRange ?? null,
    fallback: options.fallback ?? options.harnessRange === null,
    envelopes: options.envelopes ?? {},
    detect() {
      return options.unsupported
        ? {
            status: "unsupported",
            harnessVersion: null,
            source: "none",
            confidence: "low",
            reason: options.unsupported,
          }
        : {
            status: "unknown",
            harnessVersion: null,
            source: "none",
            confidence: "low",
            reason: "runtime handshake is the only signal",
          };
    },
    handshake() {
      if (options.unsupported) {
        throw new Error(`${platform}@v${major} is not implemented`);
      }
      return {
        adapterId: `${platform}@v${major}`,
        apiVersion: `v${major}`,
        supportedEvents: Object.keys(options.envelopes ?? {}),
      };
    },
  };
}

const OPENCODE_EVENTS = {
  "session-start": "opencode-v1-messages",
  "user-prompt": "opencode-v1-messages",
  "pre-tool-use": "opencode-v1-tool-before",
} as const;

export const ADAPTERS: readonly HarnessAdapter[] = [
  ...PLATFORM_IDS.filter((id) => id !== "opencode").map((id) => adapter(id)),
  adapter("opencode", {
    harnessRange: ">=1.0.0 <2.0.0",
    fallback: true,
    envelopes: OPENCODE_EVENTS,
  }),
  adapter("opencode", {
    major: 2,
    harnessRange: ">=2.0.0 <3.0.0",
    unsupported: "opencode@v2 is not implemented",
  }),
];

export function adaptersFor(platform: PlatformId): readonly HarnessAdapter[] {
  return ADAPTERS.filter((entry) => entry.platform === platform);
}

export function adapterById(id: string): HarnessAdapter | null {
  return ADAPTERS.find((entry) => entry.id === id) ?? null;
}

export function selectAdapter(input: {
  platform: PlatformId;
  detection: DetectionResult;
  pin?: string | null;
}): AdapterSelection {
  const candidates = adaptersFor(input.platform);
  if (input.pin) {
    const pinned = adapterById(input.pin);
    if (pinned?.platform === input.platform) {
      return {
        adapter: pinned,
        status: "ok",
        reason: "config-pin",
        detection: {
          ...input.detection,
          source: "config-pin",
          confidence: "high",
        },
        fallback: "none",
      };
    }
    return {
      adapter: null,
      status: "unsupported",
      reason: `pinned adapter not found: ${input.pin}`,
      detection: input.detection,
      fallback: "prelude",
    };
  }

  const version = input.detection.harnessVersion;
  if (version && input.detection.status === "detected") {
    const constrained = candidates.filter((entry) => entry.harnessRange !== null);
    if (constrained.length > 0) {
      const match = constrained.find((entry) =>
        satisfiesRange(version, entry.harnessRange ?? ""),
      );
      if (match) {
        const selfCheck = match.detect({
          platform: input.platform,
          runCommand: () => null,
        });
        if (selfCheck.status === "unsupported") {
          return {
            adapter: match,
            status: "unsupported",
            reason: selfCheck.reason ?? `adapter ${match.id} is not implemented`,
            detection: input.detection,
            fallback: "prelude",
          };
        }
        return {
          adapter: match,
          status: "ok",
          reason: "semver-match",
          detection: input.detection,
          fallback: "none",
        };
      }
      return {
        adapter: null,
        status: "unsupported",
        reason: `no adapter for harness ${version}`,
        detection: input.detection,
        fallback: "prelude",
      };
    }
    // No adapter declares a version range: the platform has one stable
    // generation, so a detected version is safe to pair with it.
    const only = candidates[0] ?? null;
    return {
      adapter: only,
      status: only ? "ok" : "unsupported",
      reason: only ? "single-generation platform" : "no adapter registered",
      detection: input.detection,
      fallback: only ? "none" : "prelude",
    };
  }

  // Unknown version: choose a fallback adapter (range === null), but mark the
  // selection degraded so doctor and the injection header can say so.
  const fallback = candidates.find(
    (entry) => entry.fallback === true || entry.harnessRange === null,
  );
  if (fallback) {
    return {
      adapter: fallback,
      status: "degraded",
      reason: input.detection.reason ?? "version-unknown",
      detection: input.detection,
      fallback: "skills",
    };
  }
  const unimplemented = candidates.find(
    (entry) => entry.detect({ platform: input.platform, runCommand: () => null }).status === "unsupported",
  );
  return {
    adapter: null,
    status: "unsupported",
    reason:
      unimplemented?.detect({ platform: input.platform, runCommand: () => null }).reason ??
      "version-unknown-no-fallback",
    detection: input.detection,
    fallback: "prelude",
  };
}

/** Adapter used by shims at runtime; handshake reports what actually loaded. */
export function runtimeAdapter(platform: PlatformId): Adapter {
  return adaptersFor(platform)[0] ?? adapter(platform);
}
