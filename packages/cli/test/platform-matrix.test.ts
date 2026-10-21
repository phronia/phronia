import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, PLATFORM_IDS } from "@phronia/core";
import { AI_TOOLS } from "../src/types/ai-tools.js";
import { resolveCommands } from "../src/configurators/shared.js";
import { collectDoctorReport } from "../src/commands/doctor.js";

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
      const report = collectDoctorReport({ cwd: root, platform: "claude-code" });
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
      const report = collectDoctorReport({ cwd: root, platform: "claude-code" });
      expect(report.environment).toEqual({ gitRepo: true, gitRemote: false });
      const byId = new Map(report.platforms[0]?.features.map((f) => [f.id, f]));
      expect(byId.get("task.branch")).toMatchObject({ available: true });
      expect(byId.get("crossRepo.task")).toMatchObject({ available: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains platform-level unavailability", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-doctor-kilo-"));
    try {
      const report = collectDoctorReport({ cwd: root, platform: "kilo" });
      const session = report.platforms[0]?.features.find(
        (feature) => feature.id === "context.sessionStart",
      );
      expect(session?.available).toBe(false);
      expect(session?.reason).toContain("class-2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
