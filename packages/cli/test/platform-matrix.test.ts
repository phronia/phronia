import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, PLATFORM_IDS } from "@phronia/core";
import { AI_TOOLS } from "../src/types/ai-tools.js";
import { resolveCommands } from "../src/configurators/shared.js";
import { collectDoctorReport } from "../src/commands/doctor.js";
import { refreshAdapterManifest } from "../src/commands/adapter-manifest.js";
import { readAdapterManifest } from "@phronia/core";

describe("platform registry derivation", () => {
  it("covers PLATFORM_IDS exactly", () => {
    expect(Object.keys(AI_TOOLS).sort()).toEqual([...PLATFORM_IDS].sort());
    for (const id of PLATFORM_IDS) {
      expect(AI_TOOLS[id].capabilities).toBe(CAPABILITIES[id]);
    }
  });

  it("derives agentCapable from agentDefinitions", () => {
    for (const id of PLATFORM_IDS) {
      expect(AI_TOOLS[id].templateContext.agentCapable).toBe(
        CAPABILITIES[id].behavior.agentDefinitions.kind !== "none",
      );
    }
  });

  it("derives autoSessionStart from the session-start mechanism", () => {
    for (const id of PLATFORM_IDS) {
      const kind = CAPABILITIES[id].behavior.sessionStart.kind;
      const expected = kind !== "none" && kind !== "native" && kind !== "prelude";
      expect(AI_TOOLS[id].templateContext.autoSessionStart).toBe(expected);
      // One-version alias for {{#HAS_HOOKS}}.
      expect(AI_TOOLS[id].templateContext.hasHooks).toBe(expected);
    }
  });

  it("derives hasPythonHooks from runtime hook mechanisms", () => {
    const expected = PLATFORM_IDS.filter((id) => {
      const behavior = CAPABILITIES[id].behavior;
      return [
        behavior.sessionStart,
        behavior.subagentContext,
        behavior.workflowState,
        behavior.shellIdentity,
      ].some((mechanism) => mechanism.kind === "hook" || mechanism.kind === "config");
    });
    const actual = PLATFORM_IDS.filter((id) => AI_TOOLS[id].hasPythonHooks);
    expect(actual).toEqual(expected);
    expect(actual).not.toContain("dsh");
    expect(actual).not.toContain("pi");
    expect(actual).not.toContain("omp");
    expect(actual).toContain("snow");
  });

  it("keeps start only when automatic session start is unavailable", () => {
    for (const id of PLATFORM_IDS) {
      const ctx = AI_TOOLS[id].templateContext;
      const hasStart = resolveCommands(ctx).some((command) => command.name === "start");
      expect(hasStart).toBe(!(ctx.agentCapable && ctx.autoSessionStart));
    }
  });
});

describe("doctor report", () => {
  it("reports git-dependent features as unavailable outside a repo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-doctor-nogit-"));
    try {
      const report = collectDoctorReport({ cwd: root, platform: "claude-code", probe: false });
      expect(report.platforms[0]?.id).toBe("claude-code");
      const byId = new Map(report.platforms[0]?.features.map((f) => [f.id, f]));
      expect(byId.get("task.branch")).toMatchObject({ available: false });
      expect(byId.get("task.worktree")).toMatchObject({ available: false });
      expect(byId.get("crossRepo.task")).toMatchObject({ available: false });
      expect(byId.get("context.sessionStart")).toMatchObject({ available: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports crossRepo.task unavailable without a remote", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-doctor-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const report = collectDoctorReport({ cwd: root, platform: "claude-code", probe: false });
      expect(report.environment).toEqual({ gitRepo: true, gitRemote: false });
      const byId = new Map(report.platforms[0]?.features.map((f) => [f.id, f]));
      expect(byId.get("task.branch")).toMatchObject({ available: true });
      expect(byId.get("crossRepo.task")).toMatchObject({ available: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the ZCode integration path and honors a config pin", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-doctor-zcode-"));
    try {
      fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".phronia", "config.yaml"),
        "platforms:\n  zcode:\n    path: prelude\n",
      );
      const report = collectDoctorReport({ cwd: root, platform: "zcode", probe: false });
      expect(report.platforms[0]?.zcode).toMatchObject({
        path: "prelude",
        trust: "unknown",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a degraded adapter record when probing is disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-doctor-manifest-"));
    try {
      const result = refreshAdapterManifest(root, {
        platforms: ["claude-code"],
        probe: false,
      });
      expect(result[0]).toMatchObject({
        id: "claude-code",
        adapterId: "claude-code@v1",
        status: "degraded",
        source: "none",
      });
      const manifest = readAdapterManifest(root);
      expect(manifest.platforms["claude-code"]?.status).toBe("degraded");
      expect(manifest.platforms["claude-code"]?.harnessVersion).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains platform-level unavailability", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-doctor-kilo-"));
    try {
      const report = collectDoctorReport({ cwd: root, platform: "kilo", probe: false });
      const session = report.platforms[0]?.features.find(
        (feature) => feature.id === "context.sessionStart",
      );
      expect(session?.available).toBe(false);
      expect(session?.reason).toContain("class-2");
      expect(report.platforms[0]?.adapter.adapterId).toBe("kilo@v1");
      expect(report.platforms[0]?.adapter.status).toBe("degraded");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
