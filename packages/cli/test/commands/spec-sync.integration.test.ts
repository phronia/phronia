/**
 * `phronia task spec plan|commit|status` integration.
 *
 * Every test builds a throwaway repository; the real service acquires the
 * shared integration lock and runs git in the main checkout.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLeaseStore,
  type LeaseHandle,
  type LeaseRecord,
} from "../../src/adapters/lease.js";
import {
  commitSpecSync,
  planSpecSync,
  statusSpecSync,
} from "../../src/services/spec-sync.js";
import { integrateTask } from "../../src/services/integrate.js";

const SPEC_A = ".phronia/spec/guides/a.md";
const SPEC_B = ".phronia/spec/guides/b.md";
const SPEC_C = ".phronia/spec/guides/c.md";

describe("task spec sync integration", { timeout: 30_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("plan refuses a task that has not landed", () => {
    writeTask(root, "10-29-alpha", { outcome: "none" });

    const result = planSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SPEC_SYNC_NOT_LANDED");
    expect(result.next).toContain("integrate");
  });

  it("plan skips a landed task without spec-delta.md", () => {
    const landed = landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });

    const result = planSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      taskRef: ".phronia/tasks/10-29-alpha",
      status: "none",
      delta: null,
      targetFiles: [],
      landedDiff: { baseSha: landed.baseSha, commit: landed.commit },
    });
  });

  it("plan reports the delta, landed diff files, targets, and current hashes", () => {
    const landed = landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);

    const result = planSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const task = result.tasks[0];
    expect(task?.status).toBe("ready");
    expect(task?.targetFiles).toEqual([SPEC_A]);
    expect(task?.delta).toBe(".phronia/tasks/10-29-alpha/spec-delta.md");
    expect(task?.landedDiff.files).toContain("src/a.txt");
    expect(task?.landedDiff.baseSha).toBe(landed.baseSha);
    expect(task?.landedDiff.commit).toBe(landed.commit);
    expect(task?.currentSpec).toHaveLength(1);
    expect(task?.currentSpec[0]?.path).toBe(SPEC_A);
    expect(task?.currentSpec[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("commit writes only .phronia/spec, commits, and records meta.spec_sync", () => {
    const landed = landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");

    const result = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([SPEC_A]);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.metadataCommit).not.toBeNull();

    const specCommitFiles = gitOut(root, [
      "show",
      "--name-only",
      "--format=",
      result.commit,
    ])
      .split("\n")
      .filter((line) => line !== "");
    expect(specCommitFiles).toEqual([SPEC_A]);
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");

    const task = readTaskJson(root, "10-29-alpha");
    expect(metaOf(task).spec_sync).toEqual({
      status: "synced",
      commit: result.commit,
      synced_at: expect.any(String),
      refs: [".phronia/tasks/10-29-alpha"],
      mode: "agent",
    });
    expect(metaOf(task).integration).toMatchObject({
      outcome: "landed",
      commit: landed.commit,
    });
  });

  it("commits two tasks serially without interleaving their spec files", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    landTask(root, "10-29-beta", { codeFile: "src/b.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    writeDelta(root, "10-29-beta", [SPEC_B]);

    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    const first = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.files).toEqual([SPEC_A]);

    fs.writeFileSync(path.join(root, SPEC_B), "# B v2\n");
    const second = commitSpecSync({ cwd: root, refs: ["10-29-beta"] });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.files).toEqual([SPEC_B]);
    expect(second.commit).not.toBe(first.commit);

    expect(metaOf(readTaskJson(root, "10-29-alpha")).spec_sync?.status).toBe(
      "synced",
    );
    expect(metaOf(readTaskJson(root, "10-29-beta")).spec_sync?.status).toBe(
      "synced",
    );
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a mixed-base plan and commit with SPEC_SYNC_BASE_MISMATCH", () => {
    landTask(root, "10-29-alpha", {
      codeFile: "src/a.txt",
      baseBranch: "main",
    });
    landTask(root, "10-29-beta", {
      codeFile: "src/b.txt",
      baseBranch: "release/1.x",
    });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    writeDelta(root, "10-29-beta", [SPEC_B]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    fs.writeFileSync(path.join(root, SPEC_B), "# B v2\n");
    const refs = ["10-29-alpha", "10-29-beta"];
    const next =
      "sync tasks that target the same base in one call, or pass tasks with a single base";

    const plan = planSpecSync({ cwd: root, refs });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("SPEC_SYNC_BASE_MISMATCH");
    expect(plan.next).toBe(next);
    expect(plan.message).toContain(".phronia/tasks/10-29-alpha -> main");
    expect(plan.message).toContain(
      ".phronia/tasks/10-29-beta -> release/1.x",
    );

    const before = gitOut(root, ["rev-parse", "HEAD"]);
    const commit = commitSpecSync({ cwd: root, refs });
    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.code).toBe("SPEC_SYNC_BASE_MISMATCH");
    expect(commit.next).toBe(next);
    expect(commit.details?.bases).toEqual(["main", "release/1.x"]);
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(
      fs.existsSync(path.join(root, ".git/phronia/integration.lock")),
    ).toBe(false);
    expect(gitOut(root, ["status", "--porcelain"])).toContain(SPEC_A);
    expect(gitOut(root, ["status", "--porcelain"])).toContain(SPEC_B);
    expect(metaOf(readTaskJson(root, "10-29-alpha")).spec_sync).toBeUndefined();
    expect(metaOf(readTaskJson(root, "10-29-beta")).spec_sync).toBeUndefined();
  });

  it("refuses a configured integration branch that differs from a task base", () => {
    landTask(root, "10-29-alpha", {
      codeFile: "src/a.txt",
      baseBranch: "main",
    });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      ["parallel:", "  integration:", "    branch: release/1.x", ""].join("\n"),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "configure integration branch"]);

    const plan = planSpecSync({ cwd: root, refs: ["10-29-alpha"] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("SPEC_SYNC_BASE_MISMATCH");
    expect(plan.message).toContain("parallel.integration.branch is release/1.x");
    expect(plan.message).toContain(".phronia/tasks/10-29-alpha targets main");
  });

  it("syncs two tasks in one call when they share a base", () => {
    landTask(root, "10-29-alpha", {
      codeFile: "src/a.txt",
      baseBranch: "main",
    });
    landTask(root, "10-29-beta", {
      codeFile: "src/b.txt",
      baseBranch: "main",
    });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    writeDelta(root, "10-29-beta", [SPEC_B]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    fs.writeFileSync(path.join(root, SPEC_B), "# B v2\n");
    const refs = ["10-29-alpha", "10-29-beta"];

    const plan = planSpecSync({ cwd: root, refs });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);

    const commit = commitSpecSync({ cwd: root, refs });
    expect(commit.ok, JSON.stringify(commit)).toBe(true);
    if (!commit.ok) return;
    expect(commit.files.sort()).toEqual([SPEC_A, SPEC_B].sort());
    expect(metaOf(readTaskJson(root, "10-29-alpha")).spec_sync?.status).toBe(
      "synced",
    );
    expect(metaOf(readTaskJson(root, "10-29-beta")).spec_sync?.status).toBe(
      "synced",
    );
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");
  });

  it("refuses while another integration holds the lock", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    const held = holdIntegrationLock(root);

    try {
      const busy = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });
      expect(busy.ok).toBe(false);
      if (busy.ok) return;
      expect(busy.code).toBe("SPEC_SYNC_LOCK_BUSY");
      expect(fs.existsSync(path.join(root, SPEC_A))).toBe(true);
      expect(metaOf(readTaskJson(root, "10-29-alpha")).spec_sync).toBeUndefined();
    } finally {
      releaseIntegrationLock(root, held);
    }

    const after = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });
    expect(after.ok, JSON.stringify(after)).toBe(true);
  });

  it("refuses when no spec file changed", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);

    const result = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SPEC_SYNC_NO_CHANGES");
    expect(result.next).toContain("spec plan");
  });

  it("refuses a target outside .phronia/spec", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", ["docs/requirements.md"]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");

    const invalid = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.code).toBe("SPEC_SYNC_TARGET_INVALID");
    expect(invalid.message).toContain("docs/requirements.md");
  });

  it("refuses a declared target that did not change", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(path.join(root, SPEC_B), "# B v2\n");

    const missing = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("SPEC_SYNC_TARGET_INVALID");
    expect(missing.message).toContain(SPEC_A);
  });

  it("allows a declared target that did not change with --allow-missing", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A, SPEC_B]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");

    const result = commitSpecSync({
      cwd: root,
      refs: ["10-29-alpha"],
      allowMissing: true,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain(SPEC_B);
  });

  it("refuses non-spec changes in the main checkout", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    fs.writeFileSync(path.join(root, "src/unrelated.txt"), "dirty\n");

    const result = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SPEC_SYNC_DIRTY_MAIN");
    expect(result.details?.paths).toEqual(["src/unrelated.txt"]);
  });

  it("status reports pending, synced, and none", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    landTask(root, "10-29-beta", { codeFile: "src/b.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);

    const pending = statusSpecSync({ cwd: root, refs: ["10-29-alpha", "10-29-beta"] });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.tasks.map((task) => task.state)).toEqual(["pending", "none"]);

    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    const committed = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });
    expect(committed.ok).toBe(true);

    const synced = statusSpecSync({ cwd: root, refs: ["10-29-alpha"] });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.tasks[0]?.state).toBe("synced");
    expect(synced.tasks[0]?.commit).toBe(committed.ok ? committed.commit : null);
  });

  it("bedrock-style: three worktree tasks land serially, then one spec commit", () => {
    const tasks = [
      { id: "10-29-w1", code: "src/w1.txt", target: SPEC_A, spec: "# A done\n" },
      { id: "10-29-w2", code: "src/w2.txt", target: SPEC_B, spec: "# B done\n" },
      { id: "10-29-w3", code: "src/w3.txt", target: SPEC_C, spec: "# C done\n" },
    ];

    for (const task of tasks) {
      writeTask(root, task.id, { outcome: "none" });
      writeDelta(root, task.id, [task.target]);
      const wt = addTaskWorktree(root, task.id);
      writeFileAndCommit(wt, task.code, `// ${task.id}\n`, `code ${task.id}`);
    }

    for (const task of tasks.reverse()) {
      const integrated = integrateTask({
        cwd: root,
        taskRef: task.id,
        noVerify: true,
        env: {},
        ownerId: `task:.phronia/tasks/${task.id}`,
      });
      expect(integrated.ok, JSON.stringify(integrated)).toBe(true);
      if (!integrated.ok) return;
      expect(integrated.outcome).toBe("landed");
    }

    const plan = planSpecSync({ cwd: root, refs: tasks.map((task) => task.id) });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    if (!plan.ok) return;
    expect(plan.tasks.every((task) => task.status === "ready")).toBe(true);

    for (const task of tasks) {
      fs.writeFileSync(path.join(root, task.target), task.spec);
    }
    const committed = commitSpecSync({
      cwd: root,
      refs: tasks.map((task) => task.id),
    });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    if (!committed.ok) return;
    expect(committed.files.sort()).toEqual(
      [SPEC_A, SPEC_B, SPEC_C].sort(),
    );

    for (const task of tasks) {
      expect(fs.readFileSync(path.join(root, task.target), "utf8")).toBe(
        task.spec,
      );
      expect(fs.readFileSync(path.join(root, task.code), "utf8")).toBe(
        `// ${task.id}\n`,
      );
      expect(metaOf(readTaskJson(root, task.id)).spec_sync?.status).toBe(
        "synced",
      );
    }
    expect(gitOut(root, ["rev-list", "--merges", "--count", "HEAD"])).toBe("0");
    expect(gitOut(root, ["status", "--porcelain"])).toBe("");
  });
  it("S3/R6: a configured ignored input does not block spec sync", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      [
        "parallel:",
        "  integration:",
        "    ignored_inputs:",
        "      - sdk-pin",
      ].join("\n"),
    );
    git(root, ["add", ".phronia/config.yaml"]);
    git(root, ["commit", "-q", "-m", "configure ignored inputs"]);

    fs.mkdirSync(path.join(root, "sdk-cache"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "sdk-cache"),
      path.join(root, "sdk-pin"),
      "dir",
    );

    const result = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([SPEC_A]);
  });

  it("S3/R6: an undeclared symlink still refuses with SPEC_SYNC_DIRTY_MAIN", () => {
    landTask(root, "10-29-alpha", { codeFile: "src/a.txt" });
    writeDelta(root, "10-29-alpha", [SPEC_A]);
    fs.writeFileSync(path.join(root, SPEC_A), "# A v2\n");
    fs.mkdirSync(path.join(root, "sdk-cache"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "sdk-cache"),
      path.join(root, "sdk-pin"),
      "dir",
    );

    const result = commitSpecSync({ cwd: root, refs: ["10-29-alpha"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SPEC_SYNC_DIRTY_MAIN");
    expect(result.details?.paths).toContain("sdk-pin");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-spec-sync-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/"].join("\n"),
  );
  fs.mkdirSync(path.join(root, ".phronia/spec/guides"), { recursive: true });
  fs.writeFileSync(path.join(root, SPEC_A), "# A v1\n");
  fs.writeFileSync(path.join(root, SPEC_B), "# B v1\n");
  fs.writeFileSync(path.join(root, SPEC_C), "# C v1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

interface LandedTask {
  readonly baseSha: string;
  readonly commit: string;
}

/**
 * Create a task record, commit a synthetic code landing, then record
 * `meta.integration` on that task. The metadata commit is intentionally after
 * the code commit, so `base_sha..commit` is the task's landed diff.
 */
function landTask(
  root: string,
  id: string,
  options: { readonly codeFile: string; readonly baseBranch?: string },
): LandedTask {
  writeTask(root, id, {
    outcome: "none",
    ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
  });
  const baseSha = gitOut(root, ["rev-parse", "HEAD"]);
  const file = path.join(root, options.codeFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `// ${id}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", `code ${id}`]);
  const commit = gitOut(root, ["rev-parse", "HEAD"]);

  writeTask(root, id, {
    outcome: "landed",
    baseSha,
    commit,
    update: true,
    ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", `record integration ${id}`]);
  return { baseSha, commit };
}

function writeTask(
  root: string,
  id: string,
  options: {
    readonly outcome: string;
    readonly baseSha?: string;
    readonly commit?: string;
    readonly update?: boolean;
    readonly baseBranch?: string;
  },
): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  const existing = options.update === true ? readRawTask(dir) : null;
  const record = {
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
    base_branch: options.baseBranch ?? null,
    worktree_path: null,
    commit: null,
    pr_url: null,
    subtasks: [],
    children: [],
    parent: null,
    relatedFiles: [],
    notes: "",
    meta: {
      ...(existing && isRecord(existing.meta) ? existing.meta : {}),
      integration: {
        mode: "local",
        outcome: options.outcome,
        base_sha: options.baseSha ?? null,
        commit: options.commit ?? null,
        pr_url: null,
        verified: true,
        last_error: null,
        log_ref: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  fs.writeFileSync(
    path.join(dir, "task.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function writeDelta(root: string, id: string, targets: readonly string[]): void {
  const file = path.join(root, ".phronia/tasks", id, "spec-delta.md");
  fs.writeFileSync(
    file,
    [
      "# Spec Delta",
      "",
      "## Target files",
      ...targets.map((target) => `- ${target}`),
      "",
      "## Intended changes",
      "- update the contract",
      "",
      "## Rationale",
      "- the code landed",
      "",
      "## Verification",
      "- inspect the spec",
      "",
    ].join("\n"),
  );
  // Task artifacts (including the delta) are committed before integration in
  // the real flow; commit here so only spec changes are dirty for `commit`.
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", `task artifacts ${id}`]);
}

function readRawTask(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")) as Record<
    string,
    unknown
  >;
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
    createdAt: "2026-10-29T00:00:00.000Z",
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

function writeFileAndCommit(
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

function readTaskJson(root: string, id: string): Record<string, unknown> {
  return readRawTask(path.join(root, ".phronia/tasks", id));
}

function metaOf(task: Record<string, unknown>): Record<string, unknown> {
  return isRecord(task.meta) ? task.meta : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function holdIntegrationLock(root: string): LeaseHandle<LeaseRecord> {
  const target = path.join(root, ".git/phronia/integration.lock");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const store = createLeaseStore<LeaseRecord>({
    path: target,
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

function releaseIntegrationLock(root: string, handle: LeaseHandle<LeaseRecord>): void {
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
