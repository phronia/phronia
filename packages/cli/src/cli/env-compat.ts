/**
 * One-version compatibility for the environment prefix rename.
 *
 * `TRELLIS_*` is copied to `PHRONIA_*` before any command module evaluates, so
 * every downstream read can use the new prefix. The mapping is one-way and
 * never overwrites an explicit new-style value.
 *
 * This module must be the first import of the CLI entrypoint.
 */

export const LEGACY_ENV_PREFIX = "TRELLIS_";
export const CURRENT_ENV_PREFIX = "PHRONIA_";

let installed = false;
let aliasedNames: readonly string[] = Object.freeze([]);

export function installLegacyEnvAliases(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const aliased: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX)) {
      continue;
    }
    const current = `${CURRENT_ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[current] === undefined) {
      env[current] = env[key];
      aliased.push(key);
    }
  }
  installed = true;
  aliasedNames = Object.freeze(aliased);
  return aliasedNames;
}

export function legacyAliases(): readonly string[] {
  return installed ? aliasedNames : installLegacyEnvAliases();
}

const aliased = installLegacyEnvAliases();
if (aliased.length > 0 && process.env.PHRONIA_QUIET !== "1") {
  process.stderr.write(
    `ℹ️  TRELLIS_* environment variables are deprecated; mapped ${aliased.length} name(s) to PHRONIA_*. The legacy prefix is removed in the next major version.\n`,
  );
}
