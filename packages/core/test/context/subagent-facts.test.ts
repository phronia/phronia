import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentMutationFor,
  buildDispatchFacts,
} from "../../src/context/subagent/facts.js";
import { openState, type StateReader } from "../../src/state/index.js";
import {
  readRuntimeFacts,
  type RuntimeFacts,
} from "../../src/state/runtime-facts.js";
import { evaluateDispatch } from "../../src/task/dispatch/policy.js";
import type {
  DispatchFacts,
  DispatchVerdict,
} from "../../src/task/dispatch/types.js";
import { GIT_AVAILABLE, createProject } from "./runtime-fixture.js";

const LEAF = ".phronia/tasks/10-28-leaf";
const PARENT = ".phronia/tasks/10-28-parent";
const SIBLING = ".phronia/tasks/10-28-sibling";
const OTHER = ".phronia/tasks/10-28-other";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface StepResult {
  readonly facts: DispatchFacts;
  readonly verdict: DispatchVerdict;
  readonly runtime: RuntimeFacts;
  readonly state: StateReader;
}

function step(
  root: string,
  options: {
    requestedRef?: string;
    agent?: "mutating" | "read-only" | "unknown";
    exec?: Parameters<typeof readRuntimeFacts>[0]["exec"];
  } = {},
): StepResult {
  const state = openState({ root, env: {} });
  const requestedRef = options.requestedRef ?? null;
  const sessionActive = state.sessions.active(
    { session_id: "abc" },
    { platform: "claude-code", allowSingleSessionFallback: false },
  );
  const effectiveActive = state.sessions.active(
    { session_id: "abc" },
    {
      platform: "claude-code",
      taskRef: requestedRef,
      allowSingleSessionFallback: false,
    },
  );
  const runtime = readRuntimeFacts({
    root,
    includeMainDirty: true,
    ...(options.exec === undefined ? {} : { exec: options.exec }),
  });
  const facts = buildDispatchFacts({
    state,
    root,
    runtime,
    sessionActive,
    effectiveActive,
    requestedRef,
    agent: options.agent ?? "mutating",
    platform: { id: "claude-code" },
    enforce: "block",
    sessionKey: sessionActive.contextKey,
  });
  return { facts, verdict: evaluateDispatch(facts), runtime, state };
}

function writeRegistry(
  root: string,
  entries: readonly Record<string, unknown>[],
): void {
  const file = path.join(root, ".git/phronia/worktrees.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, worktrees: entries }));
}

function existingDir(parent: string, name: string): string {
  const target = path.join(parent, name);
  fs.mkdirSync(target, { recursive: true });
  return fs.realpathSync(target);
}

/** A linked worktree whose common dir is the fixture's `.git`. */
function linkedWorktree(mainRoot: string, name = "wt"): string {
  const main = fs.realpathSync(mainRoot);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-wt-"));
  roots.push(worktree);
  const gitdir = path.join(main, ".git/worktrees", name);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(
    path.join(gitdir, "HEAD"),
    "ref: refs/heads/phronia/10-28-leaf\n",
  );
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  fs.symlinkSync(path.join(main, ".phronia"), path.join(worktree, ".phronia"));
  return worktree;
}

describe("dispatch facts mapping", () => {
  it("reports a parent task as a container", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(PARENT, {
      status: "in_progress",
      children: [LEAF, SIBLING],
    });
    fixture.writeTask(LEAF, { status: "in_progress", parent: PARENT });
    fixture.writeTask(SIBLING, { status: "planning", parent: PARENT });
    fixture.writeSession("claude_abc", PARENT);

    const { facts, verdict } = step(fixture.root);
    expect(facts.effectiveTask?.children).toEqual([LEAF, SIBLING]);
    expect(facts.siblings).toEqual({ total: 2, inProgress: 1, planning: 1 });
    expect(verdict.decision).toBe("block");
    expect(verdict.code).toBe("DISPATCH_PARENT_TASK");
  });

  it("blocks a task that has not been started", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "planning" });
    fixture.writeSession("claude_abc", LEAF);

    expect(step(fixture.root).verdict.code).toBe(
      "DISPATCH_TASK_NOT_IN_PROGRESS",
    );
  });

  it("blocks a dispatch from the main checkout when the task has a worktree", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress", branch: "phronia/leaf" });
    fixture.writeSession("claude_abc", LEAF);
    const worktree = existingDir(fixture.root, ".phronia/worktrees/leaf");
    writeRegistry(fixture.root, [
      {
        taskRef: LEAF,
        path: worktree,
        branch: "phronia/leaf",
        kind: "phronia",
        provisional: false,
      },
    ]);

    const { facts, verdict } = step(fixture.root);
    expect(facts.workspace?.taskWorktree).toBe(worktree);
    expect(verdict.code).toBe("DISPATCH_WRONG_CHECKOUT");
  });

  it("blocks a linked worktree registered to another task", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeTask(OTHER, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);
    const worktree = linkedWorktree(fixture.root);
    writeRegistry(fixture.root, [
      {
        taskRef: OTHER,
        path: worktree,
        branch: "phronia/other",
        kind: "phronia",
        provisional: false,
      },
    ]);

    const { facts, verdict } = step(worktree);
    expect(facts.checkout.isLinkedWorktree).toBe(true);
    expect(facts.checkout.registeredTaskRef).toBe(OTHER);
    expect(verdict.code).toBe("DISPATCH_CHECKOUT_OWNED_BY_OTHER");
  });

  it("flags an unregistered linked worktree instead of blocking", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);
    const worktree = linkedWorktree(fixture.root);

    const { facts, verdict } = step(worktree);
    expect(facts.checkout.registeredTaskRef).toBeNull();
    expect(verdict.decision).toBe("allow");
    expect(verdict.code).toBe("DISPATCH_CHECKOUT_UNREGISTERED");
    expect(verdict.guard).not.toBeNull();
  });

  it("requires isolation when two siblings are in progress", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(PARENT, {
      status: "in_progress",
      children: [LEAF, SIBLING],
    });
    fixture.writeTask(LEAF, { status: "in_progress", parent: PARENT });
    fixture.writeTask(SIBLING, { status: "in_progress", parent: PARENT });
    fixture.writeSession("claude_abc", LEAF);

    const { facts, verdict } = step(fixture.root);
    expect(facts.siblings).toEqual({
      total: 2,
      inProgress: 2,
      planning: 0,
    });
    expect(verdict.code).toBe("DISPATCH_ISOLATION_REQUIRED");
  });

  it("inherits a parent's worktree=always isolation policy", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(PARENT, {
      status: "in_progress",
      children: [LEAF],
      meta: { parallel: { worktree: "always" } },
    });
    fixture.writeTask(LEAF, {
      status: "in_progress",
      parent: PARENT,
      meta: { parallel: { worktree: "auto" } },
    });
    fixture.writeSession("claude_abc", LEAF);

    const { facts, verdict } = step(fixture.root);
    expect(facts.effectiveTask?.parallel.worktree).toBe("always");
    expect(verdict.code).toBe("DISPATCH_ISOLATION_REQUIRED");
  });

  it("blocks when the main checkout is claimed by another task", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);
    fixture.writeClaim({ taskRef: OTHER, ownerRef: `task:${OTHER}` });

    expect(step(fixture.root).verdict.code).toBe("DISPATCH_MAIN_CLAIMED");
  });

  it("blocks a stale claim when the main checkout is dirty", () => {
    const fixture = createProject({ git: GIT_AVAILABLE });
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);
    fixture.writeClaim({
      taskRef: OTHER,
      ownerRef: `task:${OTHER}`,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      ttlSeconds: 1,
    });

    const { facts, verdict } = step(fixture.root);
    expect(facts.claim?.stale).toBe(true);
    expect(facts.checkout.mainDirty).toBe(true);
    expect(verdict.code).toBe("DISPATCH_STALE_CLAIM_DIRTY");
  });

  it("allows an unclaimed main checkout with a guard", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);

    const { facts, verdict } = step(fixture.root);
    expect(facts.claim).toBeNull();
    expect(verdict.decision).toBe("allow");
    expect(verdict.code).toBe("DISPATCH_NO_CLAIM");
    expect(verdict.guard?.lines.join("\n")).toContain(
      "phronia task workspace ensure .phronia/tasks/10-28-leaf",
    );
  });

  it("warns when another live session holds the task lease", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);
    fixture.writeClaim({ taskRef: LEAF, ownerRef: `task:${LEAF}` });
    fixture.writeLease(LEAF, {
      ownerId: "session-other",
      sessionKey: "session-other",
    });

    const { facts, verdict } = step(fixture.root);
    expect(facts.lease).toMatchObject({ ownerId: "session-other", stale: false });
    expect(verdict.code).toBe("DISPATCH_LEASE_OTHER_OWNER");
  });

  it("lets research dispatch through without a guard", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(PARENT, {
      status: "planning",
      children: [LEAF],
    });
    fixture.writeSession("claude_abc", PARENT);

    const { verdict } = step(fixture.root, {
      agent: agentMutationFor("research"),
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.code).toBe("DISPATCH_OUTSIDE_CONTRACT");
    expect(verdict.guard).toBeNull();
  });

  it("degrades to no-active-task when no task can be resolved", () => {
    const fixture = createProject();
    roots.push(fixture.root);

    const { facts, verdict } = step(fixture.root);
    expect(facts.effectiveTask).toBeNull();
    expect(verdict.decision).toBe("allow");
    expect(verdict.code).toBe("DISPATCH_NO_ACTIVE_TASK");
    expect(verdict.guard).toBeNull();
  });

  it("blocks a requested task outside the active task's subtree", () => {
    const fixture = createProject();
    roots.push(fixture.root);
    fixture.writeTask(PARENT, {
      status: "in_progress",
      children: [LEAF],
    });
    fixture.writeTask(LEAF, { status: "in_progress", parent: PARENT });
    fixture.writeTask(OTHER, { status: "in_progress", parent: SIBLING });
    fixture.writeSession("claude_abc", PARENT);

    const { facts, verdict } = step(fixture.root, { requestedRef: OTHER });
    expect(facts.activeTaskRef).toBe(PARENT);
    expect(facts.requestedTaskRef).toBe(OTHER);
    expect(verdict.code).toBe("DISPATCH_TASK_NOT_CHILD");
  });

  it("turns unreadable runtime facts into a guard, never a block", () => {
    const fixture = createProject({ git: false });
    roots.push(fixture.root);
    fixture.writeTask(LEAF, { status: "in_progress" });
    fixture.writeSession("claude_abc", LEAF);

    const { facts, verdict } = step(fixture.root, {
      exec: () => ({ status: 1, stdout: "", stderr: "not a repository" }),
    });
    expect(facts.factsReliable).toBe(false);
    expect(verdict.decision).toBe("allow");
    expect(verdict.code).toBe("DISPATCH_FACTS_UNRELIABLE");
    expect(verdict.guard).not.toBeNull();
  });
});
