/**
 * `phronia doctor` — explain which features are available and why not.
 *
 * This is the B4 skeleton: it joins the platform capability matrix with the
 * current project's environment. B5 adds harness-version probing and shim
 * health; the JSON shape is stable so callers can rely on it now.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  featureStatus,
  PLATFORM_IDS,
  type FeatureId,
  type PlatformId,
} from "@phronia/core";
import { getConfiguredPlatforms } from "../configurators/index.js";
import { AI_TOOLS } from "../types/ai-tools.js";

export interface DoctorEnvironment {
  gitRepo: boolean;
  gitRemote: boolean;
}

export interface DoctorFeature {
  id: FeatureId;
  available: boolean;
  reason?: string;
}

export interface DoctorPlatformReport {
  id: PlatformId;
  name: string;
  features: DoctorFeature[];
}

export interface DoctorReport {
  projectRoot: string;
  environment: DoctorEnvironment;
  platforms: DoctorPlatformReport[];
}

const FEATURES: readonly FeatureId[] = [
  "context.sessionStart",
  "context.subagent",
  "context.workflowState",
  "task.branch",
  "task.worktree",
  "crossRepo.task",
  "rules.gate",
];

export interface DoctorOptions {
  cwd: string;
  platform?: string;
  json?: boolean;
}

export function collectDoctorReport(options: DoctorOptions): DoctorReport {
  const projectRoot = path.resolve(options.cwd);
  const environment = detectEnvironment(projectRoot);
  let ids: PlatformId[];
  if (options.platform) {
    ids = (PLATFORM_IDS as readonly string[]).includes(options.platform)
      ? [options.platform as PlatformId]
      : [];
  } else {
    const configured = [...getConfiguredPlatforms(projectRoot)].sort();
    ids = configured.length > 0 ? (configured as PlatformId[]) : [];
  }

  return {
    projectRoot,
    environment,
    platforms: ids.map((id) => ({
      id,
      name: AI_TOOLS[id].name,
      features: FEATURES.map((feature) => doctorFeature(id, feature, environment)),
    })),
  };
}

export function runDoctorCommand(options: DoctorOptions): number {
  if (options.platform && !(PLATFORM_IDS as readonly string[]).includes(options.platform)) {
    process.stderr.write(`Unknown platform: ${options.platform}\n`);
    return 2;
  }
  const report = collectDoctorReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const lines = [
    "Phronia doctor",
    `Project: ${report.projectRoot}`,
    `Environment: gitRepo=${report.environment.gitRepo ? "yes" : "no"} gitRemote=${report.environment.gitRemote ? "yes" : "no"}`,
  ];
  if (report.platforms.length === 0) {
    lines.push("", "No Phronia platform is configured in this project.");
  }
  for (const platform of report.platforms) {
    lines.push("", `${platform.name} (${platform.id})`);
    for (const feature of platform.features) {
      lines.push(
        `  ${feature.id.padEnd(24)} ${feature.available ? "ok" : `unavailable: ${feature.reason ?? "unknown"}`}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function doctorFeature(
  platform: PlatformId,
  feature: FeatureId,
  environment: DoctorEnvironment,
): DoctorFeature {
  const status = featureStatus(platform, feature);
  if (!status.available) {
    return { id: feature, available: false, reason: status.reason };
  }
  if (feature === "task.branch" && !environment.gitRepo) {
    return { id: feature, available: false, reason: "not a git repository" };
  }
  if (feature === "task.worktree" && !environment.gitRepo) {
    return { id: feature, available: false, reason: "not a git repository" };
  }
  if (feature === "crossRepo.task" && !environment.gitRemote) {
    return { id: feature, available: false, reason: "no git remote configured" };
  }
  return { id: feature, available: true };
}

function detectEnvironment(cwd: string): DoctorEnvironment {
  const gitRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!gitRepo) {
    return { gitRepo: false, gitRemote: false };
  }
  const remotes = git(cwd, ["remote"]);
  return { gitRepo: true, gitRemote: remotes.length > 0 };
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
