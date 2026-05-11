import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { PACKAGE_NAME, VERSION } from "../constants/version.js";

export interface UpgradeOptions {
  tag?: string;
  dryRun?: boolean;
}

interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

type SpawnRunner = (
  command: string,
  args: string[],
  options: { stdio: "inherit" },
) => SpawnResult;

const NPM_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveUpgradeTag(
  currentVersion: string = VERSION,
  requestedTag?: string,
): string {
  if (requestedTag) {
    if (!NPM_TAG_RE.test(requestedTag)) {
      throw new Error(
        `Invalid npm tag/version "${requestedTag}". Use a simple dist-tag or version such as latest, beta, rc, or 0.6.0-beta.8.`,
      );
    }
    return requestedTag;
  }

  if (currentVersion.includes("-beta")) return "beta";
  if (currentVersion.includes("-rc")) return "rc";
  return "latest";
}

export function npmBinary(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function buildUpgradeCommand(
  options: UpgradeOptions = {},
  currentVersion: string = VERSION,
): { command: string; args: string[]; target: string; tag: string } {
  const tag = resolveUpgradeTag(currentVersion, options.tag);
  const target = `${PACKAGE_NAME}@${tag}`;
  return {
    command: npmBinary(),
    args: ["install", "-g", target],
    target,
    tag,
  };
}

export async function upgrade(
  options: UpgradeOptions = {},
  runner: SpawnRunner = spawnSync,
): Promise<void> {
  const plan = buildUpgradeCommand(options);
  const commandLine = `npm ${plan.args.join(" ")}`;

  console.log(chalk.cyan(`Upgrading Trellis CLI to ${plan.target}`));
  console.log(chalk.gray(`Run: ${commandLine}`));

  if (options.dryRun) {
    console.log(chalk.gray("Dry run: no changes made."));
    return;
  }

  const result = runner(plan.command, plan.args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(
      `Failed to run npm. Install npm or run manually: ${commandLine}`,
    );
  }
  if (result.signal) {
    throw new Error(`npm install was interrupted by ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status}.`);
  }

  console.log(chalk.green("\n✓ Trellis CLI upgrade completed"));
  console.log(chalk.gray("Run: trellis --version"));
}
