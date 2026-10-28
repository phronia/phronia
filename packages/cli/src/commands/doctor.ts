/**
 * `phronia doctor` — explain which features are available and why not.
 *
 * Joins three sources: the platform capability matrix, the project's
 * environment, and the harness adapter actually selected for each configured
 * platform. An adapter that never wrote a handshake is reported as degraded —
 * that is how a plugin that loads but never runs becomes visible.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  featureStatus,
  CAPABILITIES,
  compileRules,
  gateReportForDoctor,
  handshakeAgeMs,
  PLATFORM_IDS,
  nodeFs,
  probeHarnessVersion,
  readAdapterManifest,
  readConfig,
  readHandshake,
  selectZcodePath,
  type ZcodePathState,
  selectAdapter,
  type AdapterSelection,
  type AdapterStatus,
  type FeatureId,
  type PlatformId,
} from "@phronia/core";
import { getConfiguredPlatforms } from "../configurators/index.js";
import { ensureZcodePlugin } from "../configurators/zcode-plugin.js";
import { AI_TOOLS } from "../types/ai-tools.js";
import { refreshAdapterManifest } from "./adapter-manifest.js";

export interface DoctorEnvironment {
  gitRepo: boolean;
  gitRemote: boolean;
}

export interface DoctorFeature {
  id: FeatureId;
  available: boolean;
  reason?: string;
}

export interface DoctorAdapterReport {
  adapterId: string | null;
  harnessVersion: string | null;
  source: string;
  status: AdapterStatus;
  reason: string;
  fallback: string;
  lastHandshakeAt: string | null;
  lastHandshakeAgeMs: number | null;
}

export interface DoctorPlatformReport {
  id: PlatformId;
  name: string;
  adapter: DoctorAdapterReport;
  /** Present only for loopControl: full platforms. */
  gate?: {
    allowed: boolean;
    coverage: number;
    requiredCoverage: number;
    violations: { code: string; severity: string; message: string }[];
  };
  /** Present only for ZCode: which of the three integration paths is active. */
  zcode?: {
    path: ZcodePathState["selected"]["kind"];
    buildClass: string;
    trust: ZcodePathState["trust"];
    reason: string;
  };
  features: DoctorFeature[];
}

export interface DoctorReport {
  projectRoot: string;
  environment: DoctorEnvironment;
  platforms: DoctorPlatformReport[];
  /** Present when doctor checked/repaired the project-local ZCode plugin. */
  zcodePlugin?: {
    changed: boolean;
    pluginDir: string;
    warnings: string[];
  };
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
  /** Disable `harness --version` probes (tests, offline machines). */
  probe?: boolean;
  /** Rewrite `.phronia/manifest.json` from this run. */
  refreshManifest?: boolean;
  /** Exit non-zero on unsupported or schema-drift adapters. */
  check?: boolean;
  /**
   * Install/repair the project-local ZCode plugin before reporting. Defaults
   * to true; `--no-fix` makes doctor read-only.
   */
  fix?: boolean;
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
    platforms: ids.map((id) => {
      const selection = detectAdapter(
        projectRoot,
        id,
        options.probe !== false,
      );
      const handshake = readHandshake(projectRoot, id);
      const age = handshakeAgeMs(handshake);
      return {
        id,
        name: AI_TOOLS[id].name,
        adapter: adapterReport(selection, handshake, age),
        ...(CAPABILITIES[id].loopControl === "full"
          ? { gate: gateReport(projectRoot) }
          : {}),
        ...(id === "zcode"
          ? { zcode: zcodeReport(projectRoot, selection, handshake) }
          : {}),
        features: FEATURES.map((feature) => doctorFeature(id, feature, environment)),
      };
    }),
  };
}

export function runDoctorCommand(options: DoctorOptions): number {
  if (options.platform && !(PLATFORM_IDS as readonly string[]).includes(options.platform)) {
    process.stderr.write(`Unknown platform: ${options.platform}\n`);
    return 2;
  }

  const projectRoot = path.resolve(options.cwd);
  const configured =
    options.fix !== false ? getConfiguredPlatforms(projectRoot) : new Set();
  const hasZcodeHooks = fs.existsSync(
    path.join(projectRoot, ".zcode", "hooks", "phronia-hook.py"),
  );
  const shouldFix =
    options.fix !== false &&
    fs.existsSync(path.join(projectRoot, ".phronia")) &&
    (options.platform === "zcode" ||
      (!options.platform && (configured.has("zcode") || hasZcodeHooks)));

  let zcodePlugin: DoctorReport["zcodePlugin"];
  if (shouldFix) {
    try {
      zcodePlugin = ensureZcodePlugin(projectRoot);
    } catch (error) {
      process.stderr.write(
        `ZCode plugin: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const report = collectDoctorReport(options);
  if (zcodePlugin) {
    report.zcodePlugin = zcodePlugin;
  }
  if (options.refreshManifest) {
    refreshManifest(report);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const lines = [
    "Phronia doctor",
    `Project: ${report.projectRoot}`,
    `Environment: gitRepo=${report.environment.gitRepo ? "yes" : "no"} gitRemote=${report.environment.gitRemote ? "yes" : "no"}`,
  ];
  if (report.zcodePlugin) {
    lines.push(
      `ZCode plugin: ${report.zcodePlugin.changed ? "installed/updated" : "ok"} (${report.zcodePlugin.pluginDir})`,
    );
    for (const warning of report.zcodePlugin.warnings) {
      lines.push(`  warning: ${warning}`);
    }
  }
  if (report.platforms.length === 0) {
    lines.push("", "No Phronia platform is configured in this project.");
  }
  for (const platform of report.platforms) {
    const adapter = platform.adapter;
    lines.push(
      "",
      `${platform.name} (${platform.id})`,
      `  adapter ${adapter.adapterId ?? "(none)"}  harness ${adapter.harnessVersion ?? "unknown"} (${adapter.source})  ${adapter.status}${adapter.reason ? `: ${adapter.reason}` : ""}`,
      `  last handshake ${formatAge(adapter.lastHandshakeAgeMs)}`,
    );
    if (platform.gate) {
      lines.push(
        `  gate ${platform.gate.allowed ? "pass" : "blocked"}: coverage ${(platform.gate.coverage * 100).toFixed(1)}% (required ${(platform.gate.requiredCoverage * 100).toFixed(1)}%)`,
      );
      for (const violation of platform.gate.violations) {
        lines.push(`    ${violation.severity} ${violation.code}: ${violation.message}`);
      }
    }
    if (platform.zcode) {
      lines.push(
        `  zcode path ${platform.zcode.path} (${platform.zcode.buildClass}, trust ${platform.zcode.trust}): ${platform.zcode.reason}`,
      );
    }
    for (const feature of platform.features) {
      lines.push(
        `  ${feature.id.padEnd(24)} ${feature.available ? "ok" : `unavailable: ${feature.reason ?? "unknown"}`}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (options.check) {
    const bad = report.platforms.filter(
      (platform) =>
        platform.adapter.status === "unsupported" ||
        platform.adapter.status === "schema-drift",
    );
    return bad.length > 0 ? 1 : 0;
  }
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

function detectAdapter(
  projectRoot: string,
  platform: PlatformId,
  probe: boolean,
): AdapterSelection {
  const detection = probe
    ? probeHarnessVersion(platform)
    : {
        status: "unknown" as const,
        harnessVersion: null,
        source: "none" as const,
        confidence: "low" as const,
        reason: "probing disabled",
      };
  const manifest = readAdapterManifest(projectRoot);
  const pin = readConfig(projectRoot, nodeFs).value.adapterPins[platform] ?? null;
  const recorded = manifest.platforms[platform]?.adapterId ?? null;
  return selectAdapter({ platform, detection, pin, recorded });
}

function adapterReport(
  selection: AdapterSelection,
  handshake: ReturnType<typeof readHandshake>,
  age: number | null,
): DoctorAdapterReport {
  const adapter = selection.adapter;
  let status = selection.status;
  let reason = selection.reason;
  if (status === "ok" && adapter) {
    if (handshake?.adapterId && handshake.adapterId !== adapter.id) {
      status = "schema-drift";
      reason = `handshake reports ${handshake.adapterId}, expected ${adapter.id}`;
    } else if (!handshake && adapter.id === "opencode@v2") {
      // v2 loads local plugins through the server; a missing handshake means
      // the plugin has not run yet (or is disabled), not that the adapter is bad.
      reason = "opencode@v2 selected; no handshake yet — the plugin may not have loaded";
    }
  }
  return {
    adapterId: adapter?.id ?? null,
    harnessVersion: selection.detection.harnessVersion,
    source: selection.detection.source,
    status,
    reason,
    fallback: selection.fallback,
    lastHandshakeAt: handshake?.at ?? null,
    lastHandshakeAgeMs: age,
  };
}

function refreshManifest(report: DoctorReport): void {
  refreshAdapterManifest(report.projectRoot, {
    platforms: report.platforms.map((platform) => platform.id),
    probe: false,
  });
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "never";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function zcodeReport(
  projectRoot: string,
  selection: AdapterSelection,
  handshake: ReturnType<typeof readHandshake>,
): NonNullable<DoctorPlatformReport["zcode"]> {
  let pin: "plugin" | "project-hooks" | "bridge" | "prelude" | null = null;
  try {
    const envPin = process.env.PHRONIA_ZCODE_PATH;
    const validEnvPin =
      envPin === "plugin" ||
      envPin === "project-hooks" ||
      envPin === "bridge" ||
      envPin === "prelude"
        ? envPin
        : null;
    pin = readConfig(projectRoot, nodeFs).value.zcodePath ?? validEnvPin;
  } catch {
    pin = null;
  }
  const bridgePath = process.env.PHRONIA_ZCODE_BRIDGE ?? "";
  const pluginDir = ".zcode/plugins/phronia";
  const pluginInstalled = fs.existsSync(
    path.join(projectRoot, ...pluginDir.split("/"), ".zcode-plugin", "plugin.json"),
  );
  const state = selectZcodePath({
    version: selection.detection.harnessVersion,
    versionSource:
      selection.detection.source === "cli" ? "cli-probe" : "none",
    pin,
    handshake,
    bridgeInstalled: Boolean(bridgePath),
    bridgePath,
    pluginInstalled,
    pluginDir,
  });
  return {
    path: state.selected.kind,
    buildClass: state.build.class,
    trust: state.trust,
    reason: state.reason,
  };
}

export function runZcodeDetectCommand(options: {
  cwd: string;
  json?: boolean;
}): number {
  const report = collectDoctorReport({ cwd: options.cwd, platform: "zcode" });
  const platform = report.platforms[0];
  if (!platform) {
    process.stderr.write("ZCode adapter is not registered\n");
    return 2;
  }
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ adapter: platform.adapter, zcode: platform.zcode }, null, 2)}\n`,
    );
    return 0;
  }
  const zcode = platform.zcode;
  if (!zcode) {
    process.stderr.write("ZCode path state is unavailable\n");
    return 2;
  }
  process.stdout.write(
    [
      `ZCode adapter: ${platform.adapter.adapterId ?? "(none)"}`,
      `Harness: ${platform.adapter.harnessVersion ?? "unknown"} (${platform.adapter.source})`,
      `Path: ${zcode.path}`,
      `Build class: ${zcode.buildClass}`,
      `Trust: ${zcode.trust}`,
      `Reason: ${zcode.reason}`,
    ].join("\n") + "\n",
  );
  return 0;
}

function gateReport(projectRoot: string): NonNullable<DoctorPlatformReport["gate"]> {
  const rules = compileRules(projectRoot).rules;
  const changedPaths = gitChangedPaths(projectRoot);
  const report = gateReportForDoctor(projectRoot, rules, changedPaths);
  if (!report) {
    return { allowed: true, coverage: 1, requiredCoverage: 1, violations: [] };
  }
  return {
    allowed: report.result.allowed,
    coverage: report.result.coverage,
    requiredCoverage: report.result.requiredCoverage,
    violations: report.result.violations.map((violation) => ({
      code: violation.code,
      severity: violation.severity,
      message: violation.message,
    })),
  };
}

function gitChangedPaths(root: string): string[] {
  const output = git(root, ["status", "--porcelain"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
