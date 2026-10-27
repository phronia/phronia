/**
 * Session context-key resolution.
 *
 * Ported from `common/active_task.py`. A key names the per-window runtime file
 * that holds the active-task pointer; the resolution order is part of the
 * cross-session isolation contract and must not be reordered casually.
 */

import { createHash } from "node:crypto";
import {
  CONVERSATION_ENV_KEYS,
  SESSION_ENV_KEYS,
  TRANSCRIPT_ENV_KEYS,
  contextKeyPlatform,
  envPlatformName,
  type PlatformEnvEntry,
} from "../platform/env-tables.js";

export type ContextKeySource =
  | "env"
  | "payload-session"
  | "payload-conversation"
  | "payload-transcript"
  | "platform-env"
  | "shell-ticket"
  | "none";

export interface ContextKeyResult {
  key: string | null;
  source: ContextKeySource;
  platform: string;
}

export interface ResolveContextKeyOptions {
  platform?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  allowEnvironmentContext?: boolean;
  /** Shell-ticket lookup, injected by the caller (needs repo root + argv). */
  shellTicket?: () => string | null;
}

export const SESSION_KEYS = ["session_id", "sessionId", "sessionID"] as const;
export const CONVERSATION_KEYS = [
  "conversation_id",
  "conversationId",
  "conversationID",
] as const;
export const TRANSCRIPT_KEYS = [
  "transcript_path",
  "transcriptPath",
  "transcript",
] as const;
export const NESTED_KEYS = [
  "input",
  "properties",
  "event",
  "hook_input",
  "hookInput",
] as const;

export function resolveContextKey(
  input: unknown,
  options: ResolveContextKeyOptions = {},
): ContextKeyResult {
  const env = options.env ?? process.env;
  const data = asObject(input);
  const platform = detectPlatform(data, options.platform ?? null);

  const override = stringValue(env.PHRONIA_CONTEXT_ID ?? env.TRELLIS_CONTEXT_ID);
  if (override) {
    return { key: sanitizeKey(override) || hashValue(override), source: "env", platform };
  }

  if (data) {
    const sessionId = lookupString(data, SESSION_KEYS);
    if (sessionId) {
      return {
        key: contextKey(platform, "session", sessionId),
        source: "payload-session",
        platform,
      };
    }
    const conversationId = lookupString(data, CONVERSATION_KEYS);
    if (conversationId) {
      return {
        key: contextKey(platform, "conversation", conversationId),
        source: "payload-conversation",
        platform,
      };
    }
    const transcript = lookupString(data, TRANSCRIPT_KEYS);
    if (transcript) {
      return {
        key: contextKey(platform, "transcript", transcript),
        source: "payload-transcript",
        platform,
      };
    }
  }

  if (options.allowEnvironmentContext !== false) {
    const fromEnv = lookupEnvContextKey(platform, env);
    if (fromEnv) {
      return { key: fromEnv, source: "platform-env", platform };
    }
    const fromTicket = options.shellTicket?.() ?? null;
    if (fromTicket) {
      return { key: fromTicket, source: "shell-ticket", platform };
    }
  }

  return { key: null, source: "none", platform };
}

export function detectPlatform(
  input: Record<string, unknown> | null,
  platformHint?: string | null,
): string {
  if (platformHint) {
    const normalized = envPlatformName(platformHint) ?? platformHint;
    return sanitizeKey(normalized) || "session";
  }
  if (input) {
    for (const key of ["_phronia_platform", "phronia_platform", "platform", "source"]) {
      const value = stringValue(input[key]);
      if (value) {
        return sanitizeKey(value) || "session";
      }
    }
    if (stringValue(input.cursor_version)) {
      return "cursor";
    }
  }
  return "session";
}

export function contextKey(platformName: string, kind: string, value: string): string {
  const platform = contextKeyPlatform(platformName);
  if (kind === "transcript") {
    return `${platform}_transcript_${hashValue(value)}`;
  }
  const safe = sanitizeKey(value);
  return safe ? `${platform}_${safe}` : `${platform}_${hashValue(value)}`;
}

export function sanitizeKey(raw: string): string {
  const safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return safe.slice(0, 160);
}

export function hashValue(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

export function lookupString(
  data: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = stringValue(data[key]);
    if (value) {
      return value;
    }
  }
  for (const nestedKey of NESTED_KEYS) {
    const nested = asObject(data[nestedKey]);
    if (!nested) {
      continue;
    }
    const value = lookupString(nested, keys);
    if (value) {
      return value;
    }
  }
  return null;
}

function lookupEnvContextKey(
  platformName: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const platform = envPlatformName(platformName);
  const tables: [readonly PlatformEnvEntry[], string][] = [
    [SESSION_ENV_KEYS, "session"],
    [CONVERSATION_ENV_KEYS, "conversation"],
    [TRANSCRIPT_ENV_KEYS, "transcript"],
  ];
  for (const [table, kind] of tables) {
    for (const entry of iterEnvKeys(table, platform)) {
      for (const key of entry.keys) {
        const value = stringValue(env[key]);
        if (value) {
          return contextKey(entry.platform, kind, value);
        }
      }
    }
  }
  return null;
}

function iterEnvKeys(
  table: readonly PlatformEnvEntry[],
  platformName: string | null,
): readonly PlatformEnvEntry[] {
  if (!platformName) {
    return table;
  }
  return table.filter((entry) => entry.platform === platformName);
}

export function stringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
