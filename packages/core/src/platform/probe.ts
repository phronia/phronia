/**
 * Harness version probing.
 *
 * Detection is best-effort: a missing CLI, a timeout, or unparsable output is
 * `unknown`, never an error. The caller decides whether unknown is acceptable
 * (degraded fallback) or unsupported.
 */

import { execFileSync } from "node:child_process";
import { CAPABILITIES } from "./capabilities.js";
import type { DetectionResult } from "./adapter.js";
import type { PlatformId } from "./ids.js";
import { parseSemver } from "./semver.js";

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => string | null;

export const PROBE_COMMANDS: Partial<
  Record<PlatformId, { command: string; args: readonly string[] }>
> = {
  opencode: { command: "opencode", args: ["--version"] },
  zcode: { command: "zcode", args: ["--version"] },
  "claude-code": { command: "claude", args: ["--version"] },
  codex: { command: "codex", args: ["--version"] },
  cursor: { command: "cursor-agent", args: ["--version"] },
  gemini: { command: "gemini", args: ["--version"] },
  kiro: { command: "kiro-cli", args: ["--version"] },
  droid: { command: "droid", args: ["--version"] },
};

export function defaultCommandRunner(
  command: string,
  args: readonly string[],
): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function probeHarnessVersion(
  platform: PlatformId,
  run: CommandRunner = defaultCommandRunner,
  env: NodeJS.ProcessEnv = process.env,
): DetectionResult {
  // ZCode is a desktop app: launched hooks inherit ZCODE_APP_VERSION, while a
  // `zcode` binary may not be on PATH at all. Prefer the runtime signal so a
  // healthy hook integration is not reported as a degraded harness.
  if (platform === "zcode") {
    const appVersion = env.ZCODE_APP_VERSION?.trim();
    const parsed = appVersion ? parseSemver(appVersion) : null;
    if (parsed) {
      return {
        status: "detected",
        harnessVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
        source: "runtime",
        confidence: "high",
        reason: "ZCODE_APP_VERSION",
      };
    }
  }

  const probe = PROBE_COMMANDS[platform];
  if (!probe) {
    return {
      status: "unknown",
      harnessVersion: null,
      source: "none",
      confidence: "low",
      reason: "no version command for this platform",
    };
  }
  const output = run(probe.command, probe.args);
  if (output === null) {
    return {
      status: "unknown",
      harnessVersion: null,
      source: "none",
      confidence: "low",
      reason: `${probe.command} --version is unavailable`,
    };
  }
  const parsed = parseSemver(output);
  if (!parsed) {
    return {
      status: "unknown",
      harnessVersion: null,
      source: "cli",
      confidence: "low",
      reason: `${probe.command} --version did not contain a version`,
    };
  }
  return {
    status: "detected",
    harnessVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    source: "cli",
    confidence: "high",
  };
}

export function platformSupportsVersions(platform: PlatformId): boolean {
  return CAPABILITIES[platform] !== undefined;
}
