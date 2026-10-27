/**
 * Environment variable access with a one-version legacy fallback.
 *
 * New code reads `PHRONIA_*`. `TRELLIS_*` keeps working for the compatibility
 * window; the caller receives the legacy name so it can warn exactly once.
 */

import { LAYOUT } from "./index.js";

export const LEGACY_ENV_PREFIX = "TRELLIS_";

export interface EnvReadOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Called at most once per legacy variable name. */
  onLegacy?: (legacyName: string, newName: string) => void;
}

export interface EnvResult {
  value: string | undefined;
  /** True when the value came from the legacy prefix. */
  legacy: boolean;
  /** The name that produced the value, for diagnostics. */
  name: string;
}

export function envName(suffix: string): string {
  return `${LAYOUT.envPrefix}${suffix}`;
}

export function readEnv(suffix: string, options: EnvReadOptions = {}): EnvResult {
  const env = options.env ?? process.env;
  const name = envName(suffix);
  const legacyName = `${LEGACY_ENV_PREFIX}${suffix}`;

  const current = env[name];
  if (current !== undefined) {
    return { value: current, legacy: false, name };
  }
  const legacy = env[legacyName];
  if (legacy !== undefined) {
    options.onLegacy?.(legacyName, name);
    return { value: legacy, legacy: true, name: legacyName };
  }
  return { value: undefined, legacy: false, name };
}

/**
 * Read a boolean-ish environment flag. `1`, `true`, `yes`, `on` are true;
 * `0`, `false`, `no`, `off` are false; anything else is `undefined`.
 */
export function readEnvFlag(suffix: string, options: EnvReadOptions = {}): boolean | undefined {
  const { value } = readEnv(suffix, options);
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}
