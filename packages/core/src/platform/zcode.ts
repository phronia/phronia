/**
 * ZCode integration path selection.
 *
 * ZCode builds have flipped project-hook support more than once. Instead of
 * writing a hook config and assuming it runs, the path is a state machine:
 * project hooks when the build is known to support them, a thin self-owned
 * bridge when they are disabled, and pull-based skills when neither is
 * available. The handshake file is the only proof a path works.
 */

import type { HandshakeRecord } from "./manifest.js";
import { parseSemver, satisfiesRange } from "./semver.js";

export type ZcodePath =
  | { kind: "plugin"; pluginDir: string }
  | { kind: "project-hooks"; configPath: string }
  | { kind: "bridge"; bridgePath: string }
  | { kind: "prelude"; reason: string };

export type ZcodeBuildClass = "hooks-disabled" | "hooks-restored" | "unknown";

export interface ZcodeBuild {
  version: string | null;
  class: ZcodeBuildClass;
  source: "cli-probe" | "manifest" | "handshake" | "none";
  note?: string;
}

export interface ZcodePathState {
  selected: ZcodePath;
  build: ZcodeBuild;
  trust: "assumed" | "confirmed" | "unknown";
  reason: string;
}

export const KNOWN_ZCODE_BUILDS = [
  {
    range: ">=3.7.0 <3.8.0",
    class: "hooks-disabled",
    note: "project hooks disabled by security policy",
  },
  {
    range: ">=3.8.0 <3.9.0",
    class: "hooks-restored",
    note: "hooks restored; requires manual trust in Settings → Hooks",
  },
] as const;

export function classifyZcodeVersion(version: string | null): ZcodeBuildClass {
  if (!version || !parseSemver(version)) return "unknown";
  for (const build of KNOWN_ZCODE_BUILDS) {
    if (satisfiesRange(version, build.range)) return build.class;
  }
  return "unknown";
}

export function selectZcodePath(input: {
  version: string | null;
  versionSource?: ZcodeBuild["source"];
  pin?: "plugin" | "project-hooks" | "bridge" | "prelude" | null;
  handshake?: HandshakeRecord | null;
  bridgeInstalled?: boolean;
  pluginInstalled?: boolean;
  pluginDir?: string;
  configPath?: string;
  bridgePath?: string;
}): ZcodePathState {
  const build: ZcodeBuild = {
    version: input.version,
    class: classifyZcodeVersion(input.version),
    source: input.versionSource ?? (input.version ? "cli-probe" : "none"),
    note: KNOWN_ZCODE_BUILDS.find((entry) =>
      input.version ? satisfiesRange(input.version, entry.range) : false,
    )?.note,
  };

  if (input.pin === "prelude") {
    return {
      selected: { kind: "prelude", reason: "pinned: prelude" },
      build,
      trust: "unknown",
      reason: "pinned: prelude",
    };
  }
  if (input.pin === "bridge") {
    return {
      selected: { kind: "bridge", bridgePath: input.bridgePath ?? "" },
      build,
      trust: "unknown",
      reason: "pinned: bridge",
    };
  }
  if (input.pin === "project-hooks") {
    return {
      selected: {
        kind: "project-hooks",
        configPath: input.configPath ?? ".zcode/config.json",
      },
      build,
      trust: "assumed",
      reason: "pinned: project-hooks",
    };
  }
  if (input.pin === "plugin") {
    return {
      selected: {
        kind: "plugin",
        pluginDir: input.pluginDir ?? ".zcode/plugins/phronia",
      },
      build,
      trust: input.handshake?.at ? "confirmed" : "assumed",
      reason: "pinned: plugin",
    };
  }

  const handshakeFresh = Boolean(input.handshake?.at);
  if (input.pluginInstalled) {
    return {
      selected: {
        kind: "plugin",
        pluginDir: input.pluginDir ?? ".zcode/plugins/phronia",
      },
      build,
      trust: handshakeFresh ? "confirmed" : "assumed",
      reason: handshakeFresh
        ? "project plugin; handshake observed"
        : "project plugin installed",
    };
  }
  if (handshakeFresh) {
    return {
      selected: {
        kind: "project-hooks",
        configPath: input.configPath ?? ".zcode/config.json",
      },
      build,
      trust: "confirmed",
      reason: "handshake observed",
    };
  }

  if (build.class === "hooks-disabled") {
    if (input.bridgeInstalled) {
      return {
        selected: { kind: "bridge", bridgePath: input.bridgePath ?? "" },
        build,
        trust: "unknown",
        reason: "build disables project hooks; using bridge",
      };
    }
    return {
      selected: {
        kind: "prelude",
        reason: "build disables project hooks and no bridge is installed",
      },
      build,
      trust: "unknown",
      reason: "hooks-disabled-no-bridge",
    };
  }

  if (build.class === "hooks-restored") {
    return {
      selected: {
        kind: "project-hooks",
        configPath: input.configPath ?? ".zcode/config.json",
      },
      build,
      trust: "assumed",
      reason: "hooks restored; manual trust required",
    };
  }

  // Unknown build: prefer project hooks, but only the handshake proves it.
  return {
    selected: {
      kind: "project-hooks",
      configPath: input.configPath ?? ".zcode/config.json",
    },
    build,
    trust: "unknown",
    reason: "build unknown; waiting for the first handshake",
  };
}

export function zcodePathLabel(path: ZcodePath): string {
  switch (path.kind) {
    case "plugin":
      return `plugin (${path.pluginDir})`;
    case "project-hooks":
      return `project-hooks (${path.configPath})`;
    case "bridge":
      return `bridge (${path.bridgePath || "not installed"})`;
    case "prelude":
      return `prelude (${path.reason})`;
  }
}
