import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitPort } from "../../src/adapters/git.js";
import { createGitPort } from "../../src/adapters/git.js";
import {
  createLeaseStore,
  type LeaseHandle,
  type LeaseRecord,
} from "../../src/adapters/lease.js";
import type {
  ChangeRequestState,
  ForgePort,
} from "../../src/adapters/forge.js";
import { integrateTask } from "../../src/services/integrate.js";

describe("integrate integration (INT-01..INT-06)", { timeout: 30_000 }, () => {
  let root: string;
  let origin: string | null;
  let tempDirs: string[];

  beforeEach(() => {
    root = initRepo();
    origin = null;
    tempDirs = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (origin !== null) fs.rmSync(origin, { recursive: true, force: true });
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lands a worktree task and verifies inside the rebased task worktree", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const tool = verifyTool(tempDirs, false);

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(fs.readFileSync(path.join(root, "src/a.txt"), "utf8")).toBe("alpha\n");
    expect(fs.realpathSync(fs.readFileSync(tool.cwdFile, "utf8"))).toBe(fs.realpathSync(wt));
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");

    const landed = readTaskJson(path.join(root, ".phronia/tasks/10-28-alpha"));
    expect(integrationOf(landed).outcome).toBe("landed");
    expect(integrationOf(landed).verified).toBe(true);
    expect(typeof landed.commit).toBe("string");
  });

  it("resolves a worktree task given its full ref without nesting the worktree path", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const tool = verifyTool(tempDirs, false);

    const result = integrateTask({
      cwd: root,
      taskRef: ".phronia/tasks/10-28-alpha",
      verify: tool.commands,
      env: {},
      ownerId: "owner-alpha",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(fs.readFileSync(path.join(root, "src/a.txt"), "utf8")).toBe("alpha\n");
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");
  });

  it("INT-02: verification failure leaves the base branch and its reflog unchanged", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const tool = verifyTool(tempDirs, true);

    const before = gitOut(root, ["rev-parse", "HEAD"]);
    const reflogBefore = gitOut(root, ["reflog", "-n", "50"]);

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INTEGRATE_VERIFY_FAILED");
    expect(result.outcome).toBe("blocked");
    expect(result.conflict?.kind).toBe("semantic");
    expect(result.logPath).not.toBeNull();
    expect(fs.existsSync(result.logPath ?? "")).toBe(true);
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(gitOut(root, ["reflog", "-n", "50"])).toBe(reflogBefore);
    expect(fs.existsSync(wt)).toBe(true);

    const blocked = readTaskJson(path.join(wt, ".phronia/tasks/10-28-alpha"));
    expect(integrationOf(blocked).outcome).toBe("blocked");
    expect(integrationOf(blocked).last_error).toContain("verification failed");
  });

  it("INT-03: a clean rebase with failing verification is semantic and writes a handoff", () => {
    planTask(root, "10-28-alpha", ["src/shared/**"]);
    planTask(root, "10-28-beta", ["src/shared/**"]);
    const alpha = addTaskWorktree(root, "10-28-alpha");
    const beta = addTaskWorktree(root, "10-28-beta");
    commitFile(alpha, "src/a.txt", "alpha\n", "alpha work");
    commitFile(beta, "src/b.txt", "beta\n", "beta work");

    const ok = verifyTool(tempDirs, false);
    const fail = verifyTool(tempDirs, true);
    const alphaResult = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: ok.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(alphaResult.ok, JSON.stringify(alphaResult)).toBe(true);

    const before = gitOut(root, ["rev-parse", "HEAD"]);
    const betaResult = integrateTask({
      cwd: root,
      taskRef: "10-28-beta",
      verify: fail.commands,
      handoff: true,
      env: {},
      ownerId: ownerFor("10-28-beta"),
    });

    expect(betaResult.ok).toBe(false);
    if (betaResult.ok) return;
    expect(betaResult.code).toBe("INTEGRATE_VERIFY_FAILED");
    expect(betaResult.outcome).toBe("needs_human");
    expect(betaResult.conflict?.kind).toBe("semantic");
    expect(betaResult.handoffPath).not.toBeNull();
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);

    const handoff = fs.readFileSync(betaResult.handoffPath ?? "", "utf8");
    expect(handoff).toContain("Integration handoff");
    expect(handoff).toContain("Base: main @");
    expect(handoff).toContain("Classification: semantic");
    expect(handoff).toContain("intentional verify failure");
    expect(handoff).toContain("Next-step prompt");
    expect(handoff).toContain("10-28-alpha");
  });

  it("INT-04: remote mode pushes and opens a change request without touching main", () => {
    origin = addOrigin(root);
    planTask(root, "10-28-alpha", ["src/a/**"]);
    pushMain(root);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const forge = new MockForge();

    const before = gitOut(root, ["rev-parse", "HEAD"]);
    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      mode: "remote",
      forge,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("pushed");
    expect(result.prUrl).toBe("https://example.test/pr/1");
    expect(forge.mergeCalls).toBe(0);
    expect(forge.createCalls).toBe(1);
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(
      gitOut(origin, ["rev-parse", "refs/heads/phronia/10-28-alpha"]),
    ).toHaveLength(40);

    const pushed = readTaskJson(path.join(wt, ".phronia/tasks/10-28-alpha"));
    expect(integrationOf(pushed).outcome).toBe("pushed");
    expect(integrationOf(pushed).pr_url).toBe("https://example.test/pr/1");
    expect(pushed.pr_url).toBe("https://example.test/pr/1");
  });

  it("INT-04: remote mode without a forge CLI prints a compare URL and manual command", () => {
    origin = addOrigin(root);
    planTask(root, "10-28-alpha", ["src/a/**"]);
    pushMain(root);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const forge = new MockForge({ available: false });

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      mode: "remote",
      forge,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("pushed");
    expect(result.prUrl).toBeNull();
    expect(result.compareUrl).toContain("compare");
    expect(result.manualCommand).toContain("git push");
    expect(forge.createCalls).toBe(0);
  });

  it("regenerates a generated-file conflict once, then asks for a human", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    planTask(root, "10-28-beta", ["src/b/**"]);
    const alpha = addTaskWorktree(root, "10-28-alpha");
    const beta = addTaskWorktree(root, "10-28-beta");
    commitFile(alpha, "pnpm-lock.yaml", "alpha-lock\n", "alpha lock");
    commitFile(alpha, "src/a.txt", "alpha\n", "alpha work");
    commitFile(beta, "pnpm-lock.yaml", "beta-lock\n", "beta lock");
    commitFile(beta, "src/b.txt", "beta\n", "beta work");

    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-regen-"));
    tempDirs.push(markerDir);
    const script = path.join(markerDir, "regen.js");
    const marker = path.join(markerDir, "ran.txt");
    fs.writeFileSync(
      script,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.argv[2], 'ran');",
        "fs.writeFileSync('pnpm-lock.yaml', 'regenerated\\n');",
        "",
      ].join("\n"),
    );
    writeConfig(root, [
      "parallel:",
      "  conflicts:",
      "    regenerate:",
      `      - node ${script} ${marker}`,
    ]);

    const ok = verifyTool(tempDirs, false);
    const first = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: ok.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const before = gitOut(root, ["rev-parse", "HEAD"]);

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-beta",
      verify: ok.commands,
      env: {},
      ownerId: ownerFor("10-28-beta"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("needs_human");
    expect(result.conflict?.kind).toBe("generated");
    expect(fs.existsSync(marker)).toBe(true);
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(lockExists(root)).toBe(false);
  });

  it("INT-04: --sync marks a remotely merged task as landed", () => {
    origin = addOrigin(root);
    planTask(root, "10-28-alpha", ["src/a/**"]);
    pushMain(root);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const forge = new MockForge();

    const pushed = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      mode: "remote",
      forge,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const branchHead = gitOut(wt, ["rev-parse", "HEAD"]);
    git(origin, ["update-ref", "refs/heads/main", branchHead]);

    const mergedForge = new MockForge({
      state: {
        url: "https://example.test/pr/1",
        state: "merged",
        branch: "phronia/10-28-alpha",
        draft: false,
        mergeState: null,
      },
    });
    const synced = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      mode: "remote",
      sync: true,
      forge: mergedForge,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    if (!synced.ok) return;
    expect(synced.outcome).toBe("landed");
    expect(synced.sync).toBe("merged");
  });

  it("INT-05: recovers a crash in rebasing and verifying by retrying safely", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const tool = verifyTool(tempDirs, false);
    const baseSha = gitOut(root, ["rev-parse", "HEAD"]);

    for (const phase of ["rebasing", "verifying"] as const) {
      writeStaleLock(root, {
        phase,
        preLandSha: baseSha,
        postLandSha: null,
      });
      const result = integrateTask({
        cwd: root,
        taskRef: "10-28-alpha",
        recover: true,
        verify: tool.commands,
        env: {},
        ownerId: ownerFor("10-28-alpha"),
      });
      expect(result.ok, `${phase}: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toBe("landed");
      expect(fs.existsSync(path.join(root, "src/a.txt"))).toBe(true);
      expect(lockExists(root)).toBe(false);
      const landed = readTaskJson(path.join(root, ".phronia/tasks/10-28-alpha"));
      expect(integrationOf(landed).outcome).toBe("landed");
      // Reset to the pre-landing state for the next phase in the matrix.
      git(root, ["reset", "--hard", baseSha]);
    }
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("INT-05: recovers a crash after fast-forward by completing the task record", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const baseSha = gitOut(root, ["rev-parse", "HEAD"]);
    git(root, ["merge", "--ff-only", "phronia/10-28-alpha"]);
    const postLandSha = gitOut(root, ["rev-parse", "HEAD"]);

    writeStaleLock(root, {
      phase: "merging",
      preLandSha: baseSha,
      postLandSha,
    });
    const tool = verifyTool(tempDirs, false);
    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      recover: true,
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(gitOut(root, ["merge-base", "--is-ancestor", postLandSha, "HEAD"])).toBe("");
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");
    expect(lockExists(root)).toBe(false);
    const landed = readTaskJson(path.join(root, ".phronia/tasks/10-28-alpha"));
    expect(integrationOf(landed).outcome).toBe("landed");
  });

  it("INT-06: asks for the mode once and records it on the task", () => {
    origin = addOrigin(root);
    planTask(root, "10-28-alpha", ["src/a/**"]);
    pushMain(root);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const forge = new MockForge();
    let asked = 0;

    const first = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      forge,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
      chooseMode: () => {
        asked += 1;
        return "remote";
      },
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.mode).toBe("remote");
    expect(asked).toBe(1);

    const recorded = readTaskJson(path.join(wt, ".phronia/tasks/10-28-alpha"));
    expect(integrationOf(recorded).mode).toBe("remote");

    const second = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      forge,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
      chooseMode: () => {
        asked += 1;
        return "local";
      },
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.mode).toBe("remote");
    expect(asked).toBe(1);
  });

  it("integrates a main-based task without rebase or fast-forward", () => {
    planTask(root, "10-28-main", ["src/main/**"]);
    commitFile(root, "src/main.txt", "main task\n", "main task work");
    const tool = verifyTool(tempDirs, false);
    const taskHead = gitOut(root, ["rev-parse", "HEAD"]);

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-main",
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-main"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(result.commit).toBe(taskHead);
    expect(fs.realpathSync(fs.readFileSync(tool.cwdFile, "utf8"))).toBe(fs.realpathSync(root));
    expect(gitOut(root, ["merge-base", "--is-ancestor", taskHead, "HEAD"])).toBe("");
    const landed = readTaskJson(path.join(root, ".phronia/tasks/10-28-main"));
    expect(integrationOf(landed).outcome).toBe("landed");
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");
  });

  it("retries when the base moves during landing (CAS)", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const tool = verifyTool(tempDirs, false);
    const real = createGitPort();
    let moved = false;
    const port = new Proxy(real, {
      get(target, property, receiver): unknown {
        if (property === "mergeFf") {
          return (cwd: string, ref: string): unknown => {
            if (!moved) {
              moved = true;
              commitFile(root, "race.txt", "race\n", "race commit");
            }
            return target.mergeFf(cwd, ref);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as GitPort;

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: tool.commands,
      git: port,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(moved).toBe(true);
    expect(fs.existsSync(path.join(root, "race.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/a.txt"))).toBe(true);
    expect(fs.realpathSync(fs.readFileSync(tool.cwdFile, "utf8"))).toBe(fs.realpathSync(wt));
  });

  it("refuses without verification unless --no-verify is explicit", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const before = gitOut(root, ["rev-parse", "HEAD"]);

    const refused = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("INTEGRATE_NO_VERIFY");
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);

    const skipped = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      noVerify: true,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(skipped.ok, JSON.stringify(skipped)).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.outcome).toBe("landed");
  });

  it("serializes on the integration lock and queues/drains FIFO", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    planTask(root, "10-28-beta", ["src/b/**"]);
    const alpha = addTaskWorktree(root, "10-28-alpha");
    const beta = addTaskWorktree(root, "10-28-beta");
    commitFile(alpha, "src/a.txt", "alpha\n", "alpha work");
    commitFile(beta, "src/b.txt", "beta\n", "beta work");
    const tool = verifyTool(tempDirs, false);

    const held = holdIntegrationLock(root);
    const busy = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.code).toBe("INTEGRATE_LOCK_BUSY");
    expect(lockExists(root)).toBe(true);

    for (const id of ["10-28-alpha", "10-28-beta"]) {
      const queued = integrateTask({
        cwd: root,
        taskRef: id,
        queue: true,
        verify: tool.commands,
        env: {},
        ownerId: ownerFor(id),
      });
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
      if (!queued.ok) return;
      expect(queued.queued).toBe(true);
    }
    expect(readQueueFile(root).queue).toHaveLength(2);

    releaseIntegrationLock(root, held);
    const drained = integrateTask({
      cwd: root,
      drain: true,
      verify: tool.commands,
      env: {},
    });
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    expect(drained.results).toHaveLength(2);
    expect(drained.results?.every((item) => item.ok)).toBe(true);
    expect(readQueueFile(root).queue).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "src/a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/b.txt"))).toBe(true);
    expect(gitOut(root, ["rev-list", "--merges", "--count", "HEAD"])).toBe("0");
  });

  it("rejects --mode remote without an origin", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    addTaskWorktree(root, "10-28-alpha");
    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      mode: "remote",
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INTEGRATE_REMOTE_UNAVAILABLE");
    expect(result.next).toContain("--mode local");
  });

  it("supports --dry-run without writing runtime state", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    addTaskWorktree(root, "10-28-alpha");
    const tool = verifyTool(tempDirs, false);

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      dryRun: true,
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.mode).toBe("local");
    expect(result.warnings?.join(" ")).toContain("lock: free");
    expect(lockExists(root)).toBe(false);
    expect(fs.existsSync(path.join(root, ".git/phronia/leases"))).toBe(false);
    const task = readTaskJson(path.join(root, ".phronia/tasks/10-28-alpha"));
    expect(integrationOf(task).outcome).toBeUndefined();
  });

  it("SPEC_IN_CODE_TASK: a code task cannot commit .phronia/spec on its branch", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    commitFile(
      wt,
      ".phronia/spec/guides/a.md",
      "# A\n",
      "spec should be a delta",
    );
    const before = gitOut(root, ["rev-parse", "HEAD"]);

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      noVerify: true,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SPEC_IN_CODE_TASK");
    expect(result.next).toContain("git restore --staged --worktree .phronia/spec");
    expect(result.next).toContain("spec-delta.md");
    expect(result.details?.files).toEqual([".phronia/spec/guides/a.md"]);
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(fs.existsSync(path.join(root, ".phronia/spec/guides/a.md"))).toBe(false);
  });

  it("SPEC_IN_CODE_TASK: a spec-only task bypasses the gate and lands", () => {
    planTask(root, "10-28-spec", [".phronia/spec/**"]);
    const taskJson = path.join(root, ".phronia/tasks/10-28-spec/task.json");
    const record = JSON.parse(fs.readFileSync(taskJson, "utf8")) as {
      meta: Record<string, unknown>;
    };
    record.meta.kind = "spec";
    fs.writeFileSync(taskJson, `${JSON.stringify(record, null, 2)}\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "mark spec-only"]);

    const wt = addTaskWorktree(root, "10-28-spec");
    commitFile(wt, ".phronia/spec/guides/spec.md", "# Spec\n", "spec work");

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-spec",
      noVerify: true,
      env: {},
      ownerId: ownerFor("10-28-spec"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(fs.readFileSync(path.join(root, ".phronia/spec/guides/spec.md"), "utf8")).toBe(
      "# Spec\n",
    );
  });

  it("rolls back only with explicit confirmation", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    const preLandSha = gitOut(root, ["rev-parse", "HEAD"]);
    git(root, ["merge", "--ff-only", "phronia/10-28-alpha"]);
    const postLandSha = gitOut(root, ["rev-parse", "HEAD"]);
    writeStaleLock(root, {
      phase: "merging",
      preLandSha,
      postLandSha,
    });

    const refused = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      recover: true,
      rollback: true,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("INTEGRATE_ROLLBACK_CONFIRM");
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(postLandSha);

    const rolledBack = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      recover: true,
      rollback: true,
      yes: true,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });
    expect(rolledBack.ok, JSON.stringify(rolledBack)).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.outcome).toBe("none");
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(preLandSha);
    expect(fs.existsSync(path.join(root, "src/a.txt"))).toBe(false);
    expect(lockExists(root)).toBe(false);
  });
  it("S3/R6: a configured ignored symlink does not block integration", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");
    fs.writeFileSync(path.join(root, ".gitignore"), "sdk-cache/\n");
    writeConfig(root, [
      "parallel:",
      "  integration:",
      "    ignored_inputs:",
      "      - sdk-pin",
    ]);

    const cache = path.join(root, "sdk-cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "payload.bin"), "cached\n");
    fs.symlinkSync(cache, path.join(root, "sdk-pin"), "dir");
    fs.symlinkSync(cache, path.join(wt, "sdk-pin"), "dir");

    const tool = verifyTool(tempDirs, false);
    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("landed");
    expect(fs.readFileSync(path.join(root, "src/a.txt"), "utf8")).toBe("alpha\n");
  });

  it("S3/R6: the same symlink without ignored_inputs still blocks integrate", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    const wt = addTaskWorktree(root, "10-28-alpha");
    commitFile(wt, "src/a.txt", "alpha\n", "alpha work");

    const cache = path.join(root, "sdk-cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(cache, path.join(root, "sdk-pin"), "dir");

    const tool = verifyTool(tempDirs, false);
    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: tool.commands,
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INTEGRATE_DIRTY_CHECKOUT");
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("S3/R6: a real untracked file is dirty even when inputs are configured", () => {
    planTask(root, "10-28-alpha", ["src/a/**"]);
    addTaskWorktree(root, "10-28-alpha");
    writeConfig(root, [
      "parallel:",
      "  integration:",
      "    ignored_inputs:",
      "      - sdk-pin",
    ]);
    fs.writeFileSync(path.join(root, "real.txt"), "x\n");

    const result = integrateTask({
      cwd: root,
      taskRef: "10-28-alpha",
      verify: ["true"],
      env: {},
      ownerId: ownerFor("10-28-alpha"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INTEGRATE_DIRTY_CHECKOUT");
    expect(result.details?.dirtyPaths).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mock forge
// ---------------------------------------------------------------------------

class MockForge implements ForgePort {
  readonly kind = "github" as const;
  createCalls = 0;
  viewCalls = 0;
  mergeCalls = 0;
  private readonly availableFlag: boolean;
  private state: ChangeRequestState | null;

  constructor(options: { available?: boolean; state?: ChangeRequestState | null } = {}) {
    this.availableFlag = options.available !== false;
    this.state = options.state ?? null;
  }

  available(): boolean {
    return this.availableFlag;
  }

  createChangeRequest(): { url: string } | null {
    this.createCalls += 1;
    return this.availableFlag ? { url: "https://example.test/pr/1" } : null;
  }

  viewChangeRequest(): ChangeRequestState | null {
    this.viewCalls += 1;
    return this.availableFlag ? this.state : null;
  }

  compareUrl(): string | null {
    return "https://example.test/compare/main...task";
  }
}

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-integrate-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/"].join("\n"),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function planTask(
  root: string,
  id: string,
  touches: readonly string[],
): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    `${JSON.stringify(
      {
        id,
        name: id,
        title: `Task ${id}`,
        description: "",
        status: "in_progress",
        dev_type: null,
        scope: null,
        package: null,
        priority: "P2",
        creator: "test",
        assignee: "test",
        createdAt: "2026-01-01",
        completedAt: null,
        branch: null,
        base_branch: null,
        worktree_path: null,
        commit: null,
        pr_url: null,
        subtasks: [],
        children: [],
        parent: null,
        relatedFiles: [],
        notes: "",
        meta: { parallel: { touches } },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, "prd.md"), `# ${id}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", `plan ${id}`]);
}

function addTaskWorktree(root: string, id: string): string {
  const target = path.join(root, ".phronia/worktrees", id);
  const branch = `phronia/${id}`;
  git(root, ["worktree", "add", "-q", "-b", branch, target, "main"]);
  writeRegistryEntry(root, {
    taskRef: `.phronia/tasks/${id}`,
    path: target,
    branch,
    kind: "phronia",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return target;
}

function writeRegistryEntry(
  root: string,
  entry: {
    taskRef: string;
    path: string;
    branch: string;
    kind: "phronia" | "platform";
    createdAt: string;
  },
): void {
  const runtime = path.join(root, ".git/phronia");
  fs.mkdirSync(runtime, { recursive: true });
  const file = path.join(runtime, "worktrees.json");
  let worktrees: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      worktrees?: unknown[];
    };
    worktrees = Array.isArray(parsed.worktrees) ? parsed.worktrees : [];
  } catch {
    worktrees = [];
  }
  worktrees = worktrees.filter(
    (item) =>
      typeof item !== "object" ||
      item === null ||
      (item as { taskRef?: string }).taskRef !== entry.taskRef,
  );
  worktrees.push(entry);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, worktrees }, null, 2));
}

function writeConfig(root: string, lines: readonly string[]): void {
  fs.writeFileSync(path.join(root, ".phronia/config.yaml"), `${lines.join("\n")}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "configure parallel integration"]);
}

function addOrigin(root: string): string {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-origin-"));
  git(bare, ["init", "--bare", "-q", "-b", "main"]);
  git(root, ["remote", "add", "origin", bare]);
  return bare;
}

function pushMain(root: string): void {
  git(root, ["push", "-q", "-u", "origin", "main"]);
}

function commitFile(
  cwd: string,
  relative: string,
  content: string,
  message: string,
): void {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

function readTaskJson(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function integrationOf(task: Record<string, unknown>): Record<string, unknown> {
  const meta =
    typeof task.meta === "object" && task.meta !== null
      ? (task.meta as Record<string, unknown>)
      : {};
  return typeof meta.integration === "object" && meta.integration !== null
    ? (meta.integration as Record<string, unknown>)
    : {};
}

function ownerFor(id: string): string {
  return `task:.phronia/tasks/${id}`;
}

interface VerifyTool {
  readonly commands: string[];
  readonly cwdFile: string;
}

function verifyTool(tempDirs: string[], fail: boolean): VerifyTool {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-verify-"));
  tempDirs.push(dir);
  const script = path.join(dir, "verify.js");
  const cwdFile = path.join(dir, "cwd.txt");
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[2], process.cwd());",
      "if (process.argv[3] === 'fail') {",
      "  console.error('intentional verify failure');",
      "  process.exit(1);",
      "}",
      "console.log('verify ok');",
      "",
    ].join("\n"),
  );
  return {
    commands: [`node ${script} ${cwdFile}${fail ? " fail" : ""}`],
    cwdFile,
  };
}

function writeStaleLock(
  root: string,
  input: {
    phase: "acquiring" | "rebasing" | "verifying" | "merging" | "done";
    preLandSha: string;
    postLandSha: string | null;
  },
): void {
  const runtime = path.join(root, ".git/phronia");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, "integration.lock"),
    JSON.stringify({
      schemaVersion: 1,
      owner: ".phronia/tasks/10-28-alpha",
      taskRef: ".phronia/tasks/10-28-alpha",
      host: "test-host",
      pid: 1,
      phase: input.phase,
      baseBranch: "main",
      preLandSha: input.preLandSha,
      postLandSha: input.postLandSha,
      acquiredAt: "2020-01-01T00:00:00.000Z",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
      ttlSeconds: 1,
    }),
  );
}

function lockExists(root: string): boolean {
  return fs.existsSync(path.join(root, ".git/phronia/integration.lock"));
}

function readQueueFile(root: string): { queue: unknown[] } {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, ".git/phronia/integration.json"), "utf8"),
    ) as { queue: unknown[] };
  } catch {
    return { queue: [] };
  }
}

function holdIntegrationLock(root: string): LeaseHandle<LeaseRecord> {
  const store = createLeaseStore<LeaseRecord>({
    path: path.join(root, ".git/phronia/integration.lock"),
    host: "test-host",
    pid: 1,
  });
  const now = new Date().toISOString();
  const acquired = store.acquire({
    schemaVersion: 1,
    owner: "other-task",
    taskRef: "other-task",
    host: "test-host",
    pid: 1,
    phase: "acquiring",
    baseBranch: "main",
    preLandSha: gitOut(root, ["rev-parse", "HEAD"]),
    postLandSha: null,
    acquiredAt: now,
    heartbeatAt: now,
    ttlSeconds: 3600,
  } as LeaseRecord);
  if ("busy" in acquired) {
    throw new Error("integration lock was unexpectedly busy");
  }
  return acquired;
}

function releaseIntegrationLock(
  root: string,
  handle: LeaseHandle<LeaseRecord>,
): void {
  const store = createLeaseStore<LeaseRecord>({
    path: path.join(root, ".git/phronia/integration.lock"),
    host: "test-host",
    pid: 1,
  });
  store.release(handle);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
