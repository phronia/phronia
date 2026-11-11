import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listWorktreesWithRoot,
  prepareWorkspace,
} from "../../src/services/workspace.js";
import { collectDoctorReport } from "../../src/commands/doctor.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): { root: string; bare: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-provisioning-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-origin-"));
  git(bare, ["init", "--bare", "-q"]);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["fetch", "-q", "origin"]);
  git(root, ["remote", "set-head", "origin", "main"]);
  return { root, bare };
}

function advanceMain(root: string): void {
  for (const name of ["a.txt", "b.txt"]) {
    fs.writeFileSync(path.join(root, name), `${name}\n`);
    git(root, ["add", name]);
    git(root, ["commit", "-q", "-m", `advance ${name}`]);
  }
}

function dirtyMain(root: string): void {
  fs.appendFileSync(path.join(root, "README.md"), "dirty\n");
}

function readRegistry(root: string): {
  worktrees: { taskRef: string; path: string; branch: string; provisional?: boolean }[];
} {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".git/phronia/worktrees.json"), "utf8"),
  ) as { worktrees: { taskRef: string; path: string; branch: string; provisional?: boolean }[] };
}

describe("workspace provisioning (base + provisional workspaces)", () => {
  let root: string;
  let bare: string;

  beforeEach(() => {
    ({ root, bare } = initRepo());
    advanceMain(root);
    dirtyMain(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it("creates two isolated provisional workspaces with distinct branches", () => {
    const first = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "session-one",
      forNewTask: "fix a",
      branch: "fix/a",
      isolate: true,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok || first.provisional === undefined) return;
    expect(first.provisional.path).toContain(".phronia-workspace");
    expect(first.provisional.branch).toBe("fix/a");

    const second = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "session-one",
      forNewTask: "fix b",
      branch: "fix/b",
      isolate: true,
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok || second.provisional === undefined) return;
    expect(second.provisional.path).not.toBe(first.provisional.path);
    expect(second.provisional.branch).toBe("fix/b");

    const registry = readRegistry(root);
    expect(registry.worktrees).toHaveLength(2);
    expect(registry.worktrees.every((entry) => entry.taskRef === "")).toBe(true);
    expect(registry.worktrees.map((entry) => entry.branch).sort()).toEqual([
      "fix/a",
      "fix/b",
    ]);
  });

  it("reports the remote base, freshness, and shouldAsk in the decision", () => {
    const result = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "session-one",
      forNewTask: "fix a",
      branch: "fix/a",
      isolate: true,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.decision.kind !== "create") return;
    expect(result.decision.base).toBe("origin/main");
    expect(result.decision.baseInfo).toMatchObject({
      source: "remote-head",
      remote: true,
      freshness: "unverified",
      behind: 2,
      shouldAsk: true,
    });
  });

  it("honours --base and refuses an unknown base instead of guessing", () => {
    const local = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "session-one",
      forNewTask: "fix local",
      branch: "fix/local",
      isolate: true,
      base: "main",
    });
    expect(local.ok, JSON.stringify(local)).toBe(true);
    if (!local.ok || local.decision.kind !== "create") return;
    expect(local.decision.base).toBe("main");
    expect(local.decision.baseInfo).toMatchObject({
      source: "cli",
      remote: false,
      shouldAsk: false,
      behind: 0,
    });

    const invalid = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "session-one",
      forNewTask: "fix invalid",
      branch: "fix/invalid",
      isolate: true,
      base: "does-not-exist",
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.code).toBe("WORKTREE_BASE_INVALID");
  });

  it("lists manual sibling worktrees as unmanaged and outside the root", () => {
    const manual = path.join(path.dirname(root), `${path.basename(root)}-manual`);
    git(root, ["worktree", "add", "-q", "-b", "fix/manual", manual, "origin/main"]);

    const listing = listWorktreesWithRoot({
      cwd: root,
      includeUnmanaged: true,
    });
    expect(listing.unmanaged).toHaveLength(1);
    expect(listing.unmanaged[0]).toMatchObject({
      path: fs.realpathSync(manual),
      branch: "fix/manual",
      managed: false,
      insideRoot: false,
      outsideRepo: true,
    });
    expect(listing.worktrees).toHaveLength(1);
  });

  it("reports unmanaged worktrees in doctor without modifying them", () => {
    const manual = path.join(path.dirname(root), `${path.basename(root)}-manual`);
    git(root, ["worktree", "add", "-q", "-b", "fix/manual", manual, "origin/main"]);

    const report = collectDoctorReport({ cwd: root, probe: false, fix: false });
    expect(report.task.unmanagedWorktrees.count).toBe(1);
    expect(report.task.unmanagedWorktrees.outsideRoot).toBe(1);
    expect(report.task.unmanagedWorktrees.entries[0]).toMatchObject({
      branch: "fix/manual",
      insideRoot: false,
    });
    expect(fs.existsSync(manual)).toBe(true);
  });

  it("refuses a provisional workspace when parallel.worktree is never", () => {
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      "parallel:\n  worktree: never\n",
    );
    const result = prepareWorkspace({
      cwd: root,
      env: {},
      sessionKey: "session-one",
      forNewTask: "fix a",
      branch: "fix/a",
      isolate: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WORKSPACE_WORKTREE_DISABLED");
  });

  it("keeps the two provisional entries visible after a reload", () => {
    for (const [title, branch] of [
      ["fix a", "fix/a"],
      ["fix b", "fix/b"],
    ] as const) {
      const result = prepareWorkspace({
        cwd: root,
        env: {},
        sessionKey: "session-one",
        forNewTask: title,
        branch,
        isolate: true,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }

    const listing = listWorktreesWithRoot({ cwd: root });
    expect(listing.worktrees).toHaveLength(2);
    expect(listing.worktrees.every((entry) => entry.provisional === true)).toBe(true);
  });
});
