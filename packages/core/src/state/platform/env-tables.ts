/**
 * Platform session-identity tables.
 *
 * Ported verbatim from `common/active_task.py`. The provenance comments are
 * load-bearing: a 2026-08-05 audit found 12 of 21 previously declared names
 * had never existed, so names must not be added by analogy.
 */

export type EnvProvenance = "real" | "hook-scope" | "unverified" | "reasoned";

export interface PlatformEnvEntry {
  readonly platform: string;
  readonly keys: readonly string[];
  readonly provenance: EnvProvenance;
  readonly note?: string;
}

/**
 * MUST STAY FIRST: a DSH session can inherit an outer host's identity (DSH
 * launched from Codex still carries CODEX_THREAD_ID). The untargeted lookup
 * walks this table in order.
 */
export const SESSION_ENV_KEYS: readonly PlatformEnvEntry[] = [
  {
    platform: "dsh",
    keys: ["DSH_SESSION_ID"],
    provenance: "real",
    note: "reported 2026-08-13 against DSH 0.1.0-rc.6 from a live run",
  },
  {
    platform: "claude",
    keys: ["CLAUDE_CODE_SESSION_ID"],
    provenance: "real",
    note: "verified 2026-08-05 in a live Claude Code bash child; undocumented",
  },
  {
    platform: "codex",
    keys: ["CODEX_THREAD_ID"],
    provenance: "real",
    note: "codex-cli 0.146.0 injects this into shell children",
  },
  {
    platform: "gemini",
    keys: ["GEMINI_SESSION_ID"],
    provenance: "hook-scope",
    note: "set by Gemini's hook runner; not exported to bash children",
  },
  {
    platform: "qoder",
    keys: ["QODER_SESSION_ID"],
    provenance: "hook-scope",
    note: "injected during hook execution by the Qoder IDE plugin",
  },
  {
    platform: "kiro",
    keys: ["KIRO_SESSION_ID"],
    provenance: "unverified",
    note: "absent from kiro.dev hook docs; kept for empirical reports",
  },
  {
    platform: "copilot",
    keys: ["COPILOT_SESSION_ID", "COPILOT_SESSIONID"],
    provenance: "unverified",
    note: "not in the Copilot hooks reference",
  },
  {
    platform: "zcode",
    keys: ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"],
    provenance: "reasoned",
    note: "ZCode mirrors Claude's naming; platform-scoped lookup avoids collision",
  },
  {
    platform: "snow",
    keys: ["SNOW_SESSION_ID"],
    provenance: "real",
    note: "Snow exports this into hook/terminal/sub-agent children",
  },
  {
    platform: "opencode",
    keys: ["OPENCODE_SESSION_ID"],
    provenance: "real",
    note: "OpenCode 2.x shell tool sets it per command (tool/plugin/shell.ts)",
  },
];

/**
 * Host markers used to scope identity lookup before walking the flat table.
 *
 * The explicit `PHRONIA_HOST` wins: shims set it from a shell hook, so a
 * nested harness (ZCode launched from an OpenCode shell, or the reverse)
 * cannot borrow the parent's session variable. The remaining markers are a
 * best-effort fallback for platforms that do not set it yet.
 */
export const HOST_ENV_KEY = "PHRONIA_HOST";

export const HOST_MARKERS: readonly PlatformEnvEntry[] = [
  {
    platform: "zcode",
    keys: ["ZCODE_PROJECT_DIR", "ZCODE_PLUGIN_ROOT"],
    provenance: "real",
    note: "ZCode hook bridge exports these",
  },
  {
    platform: "opencode",
    keys: ["OPENCODE"],
    provenance: "real",
    note: "OpenCode 2.x shell sets OPENCODE=1",
  },
  {
    platform: "claude",
    keys: ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PROJECT_DIR"],
    provenance: "real",
    note: "Claude Code sets the entrypoint/project dir",
  },
];

/** Resolve the host platform from explicit or inferred markers. */
export function detectHostPlatform(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = env[HOST_ENV_KEY]?.trim();
  if (explicit) return explicit;
  for (const marker of HOST_MARKERS) {
    for (const key of marker.keys) {
      if (env[key]?.trim()) return marker.platform;
    }
  }
  return null;
}

export const CONVERSATION_ENV_KEYS: readonly PlatformEnvEntry[] = [
  {
    platform: "cursor",
    keys: ["CURSOR_CONVERSATION_ID", "CURSOR_CONVERSATIONID"],
    provenance: "real",
    note: "verified in cursor-agent; IDE support unverified",
  },
];

export const TRANSCRIPT_ENV_KEYS: readonly PlatformEnvEntry[] = [
  {
    platform: "cursor",
    keys: ["CURSOR_TRANSCRIPT_PATH"],
    provenance: "hook-scope",
    note: "documented for Cursor hook scripts; empty in the agent shell",
  },
  {
    platform: "gemini",
    keys: ["GEMINI_TRANSCRIPT_PATH"],
    provenance: "unverified",
    note: "never researched",
  },
  {
    platform: "droid",
    keys: ["FACTORY_TRANSCRIPT_PATH", "DROID_TRANSCRIPT_PATH"],
    provenance: "unverified",
    note: "never researched",
  },
  {
    platform: "qoder",
    keys: ["QODER_TRANSCRIPT_PATH"],
    provenance: "unverified",
    note: "never researched",
  },
  {
    platform: "codebuddy",
    keys: ["CODEBUDDY_TRANSCRIPT_PATH"],
    provenance: "unverified",
    note: "never researched",
  },
];

export const ENV_PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  factory: "droid",
  "factory-ai": "droid",
  "github-copilot": "copilot",
};

/**
 * ZCode intentionally reuses Claude's env name. Hooks know the host is ZCode,
 * while shell commands see only the shared name; both canonicalize to one
 * runtime filename.
 */
export const CONTEXT_KEY_PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  zcode: "claude",
  factory: "droid",
};

export function envPlatformName(platformName: string | null | undefined): string | null {
  if (!platformName || platformName === "session") {
    return null;
  }
  return ENV_PLATFORM_ALIASES[platformName] ?? platformName;
}

export function contextKeyPlatform(platformName: string): string {
  return CONTEXT_KEY_PLATFORM_ALIASES[platformName] ?? platformName;
}
