/**
 * Bedrock-style end-to-end flow (PRD acceptance C/F).
 *
 * Three leaf tasks with disjoint code footprints:
 *   1. `parallel plan` puts them in one wave (spec is not a footprint).
 *   2. Each task gets a real worktree; only code is committed on its branch.
 *   3. Serial integrate W2 -> W1 -> W3.
 *   4. `task spec plan` + apply + `task spec commit` once for all three.
 *   5. Archive all three with neither `--skip-branch-validation` nor
 *      `--skip-spec-sync`.
 *
 * The Python archive script is the shipped template, so this also exercises
 * the real branch-resolution and spec-sync gates.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateTask } from "../../src/services/integrate.js";
import { planTasks } from "../../src/services/parallel.js";
import { commitSpecSync, planSpecSync } from "../../src/services/spec-sync.js";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/workflow/scripts",
);

const SPEC_DIR = ".phronia/spec/guides";

interface E2ETask {
  readonly id: string;
  readonly code: string;
  readonly spec: string;
  readonly specContent: string;
}

const TASKS: readonly E2ETask[] = [
  {
    id: "10-29-w1",
    code: "src/w1/feature.txt",
    spec: `${SPEC_DIR}/w1.md`,
    specContent: "# W1 contract\n\nlanded by 10-29-w1\n",
  },
  {
    id: "10-29-w2",
    code: "src/w2/feature.txt",
    spec: `${SPEC_DIR}/w2.md`,
    specContent: "# W2 contract\n\nlanded by 10-29-w2\n",
  },
  {
    id: "10-29-w3",
    code: "src/w3/feature.txt",
    spec: `${SPEC_DIR}/w3.md`,
    specContent: "# W3 contract\n\nlanded by 10-29-w3\n",
  },
];

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPython())(
  "parallel spec e2e (bedrock-style)",
  { timeout: 120_000 },
  () => {
    let root: string;

    beforeEach(() => {
      root = initRepo();
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("plans one wave, lands serially, syncs spec once, and archives without skip flags", () => {
      // 1. Tasks + deltas, committed as planning artifacts.
      for (const task of TASKS) {
        writeTask(root, task.id, {
          touches: [`src/${task.id.split("-").pop()}/**`],
        });
        writeDelta(root, task.id, [task.spec]);
      }
      commitAll(root, "plan three parallel tasks");

      // 2. Spec is not an execution footprint; all three share one wave.
      const plan = planTasks({ cwd: root });
      expect(plan.ok, JSON.stringify(plan)).toBe(true);
      if (!plan.ok) return;
      expect(plan.waves).toHaveLength(1);
      expect([...(plan.waves[0]?.tasks ?? [])].sort()).toEqual(
        TASKS.map((task) => `.phronia/tasks/${task.id}`).sort(),
      );
      expect(
        plan.diagnostics.some(
          (item) =>
            item.code === "SPEC_IS_POST_INTEGRATION" && item.severity === "warn",
        ),
      ).toBe(false);

      // 3. One worktree per task; commit only code on the task branches.
      for (const task of TASKS) {
        const worktree = addTaskWorktree(root, task.id);
        writeFileAndCommit(worktree, task.code, `// ${task.id}\n`, `code ${task.id}`);

        const branchFiles = gitOut(root, [
          "diff",
          "--name-only",
          `main...phronia/${task.id}`,
        ])
          .split(/\r?\n/)
          .filter((line) => line !== "");
        expect(branchFiles).toEqual([task.code]);
        expect(branchFiles.some((file) => file.startsWith(".phronia/spec/"))).toBe(
          false,
        );
      }

      // 4. Serial integrate W2 -> W1 -> W3.
      for (const id of ["10-29-w2", "10-29-w1", "10-29-w3"]) {
        const integrated = integrateTask({
          cwd: root,
          taskRef: id,
          noVerify: true,
          env: {},
          ownerId: `task:.phronia/tasks/${id}`,
        });
        expect(integrated.ok, JSON.stringify(integrated)).toBe(true);
        if (!integrated.ok) return;
        expect(integrated.outcome).toBe("landed");
      }

      // 5. Plan the deltas, apply them in the main checkout, commit once.
      const refs = TASKS.map((task) => task.id);
      const specPlan = planSpecSync({ cwd: root, refs });
      expect(specPlan.ok, JSON.stringify(specPlan)).toBe(true);
      if (!specPlan.ok) return;
      expect(specPlan.tasks.every((task) => task.status === "ready")).toBe(true);

      for (const task of TASKS) {
        fs.writeFileSync(path.join(root, task.spec), task.specContent);
      }
      const specCommit = commitSpecSync({ cwd: root, refs });
      expect(specCommit.ok, JSON.stringify(specCommit)).toBe(true);
      if (!specCommit.ok) return;
      expect(specCommit.files.sort()).toEqual(
        TASKS.map((task) => task.spec).sort(),
      );
      expect(
        gitOut(root, ["log", "--format=%s"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("chore(spec): sync")).length,
      ).toBe(1);

      for (const task of TASKS) {
        expect(readMeta(root, task.id).spec_sync?.status).toBe("synced");
        expect(fs.readFileSync(path.join(root, task.spec), "utf8")).toBe(
          task.specContent,
        );
        expect(fs.readFileSync(path.join(root, task.code), "utf8")).toBe(
          `// ${task.id}\n`,
        );
      }

      // 6. Archive without --skip-branch-validation or --skip-spec-sync.
      for (const task of TASKS) {
        const archived = runTask(root, ["archive", task.id]);
        expect(archived.status, archived.stderr).toBe(0);
        expect(fs.existsSync(path.join(root, ".phronia/tasks", task.id))).toBe(
          false,
        );
        const archivedDir = path.join(
          root,
          ".phronia/tasks/archive",
          monthDir(),
          task.id,
        );
        expect(fs.existsSync(archivedDir)).toBe(true);
        expect(fs.existsSync(path.join(root, ".phronia/worktrees", task.id))).toBe(
          false,
        );
        expect(archived.stdout).not.toContain("--skip-branch-validation");
      }

      // No conflicts, no leftovers: all code and all three deltas are present.
      for (const task of TASKS) {
        expect(fs.existsSync(path.join(root, task.code))).toBe(true);
        expect(fs.readFileSync(path.join(root, task.spec), "utf8")).toContain(
          task.id,
        );
      }
      expect(gitOut(root, ["status", "--porcelain"])).toBe("");
    });

    it("spec-only task updates spec in the main checkout and archives without skip flags", () => {
      writeTask(root, "10-29-spec-only", { kind: "spec" });
      const spec = `${SPEC_DIR}/spec-only.md`;
      fs.writeFileSync(path.join(root, spec), "# Direct spec-only change\n");
      commitAll(root, "spec-only change");

      const plan = planTasks({ cwd: root });
      expect(plan.ok, JSON.stringify(plan)).toBe(true);
      if (!plan.ok) return;
      expect(plan.waves.flatMap((wave) => wave.tasks)).not.toContain(
        ".phronia/tasks/10-29-spec-only",
      );
      expect(
        plan.diagnostics.some((item) => item.code === "PARALLEL_SPEC_ONLY"),
      ).toBe(true);

      const archived = runTask(root, ["archive", "10-29-spec-only"]);
      expect(archived.status, archived.stderr).toBe(0);
      expect(
        fs.existsSync(
          path.join(
            root,
            ".phronia/tasks/archive",
            monthDir(),
            "10-29-spec-only",
          ),
        ),
      ).toBe(true);
      expect(fs.readFileSync(path.join(root, spec), "utf8")).toContain(
        "Direct spec-only change",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-parallel-spec-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  fs.mkdirSync(path.join(root, ".phronia/spec/guides"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/.gitignore"),
    ["worktrees/", ".runtime/", "__pycache__/", "*.pyc"].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, ".phronia/config.yaml"),
    "session_auto_commit: true\n",
  );
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(root, ".phronia/scripts"), {
    recursive: true,
  });
  for (const task of TASKS) {
    fs.writeFileSync(path.join(root, task.spec), `# ${task.id} v1\n`);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function writeTask(
  root: string,
  id: string,
  options: { readonly touches?: readonly string[]; readonly kind?: string },
): void {
  const dir = path.join(root, ".phronia/tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  const parallel =
    options.touches === undefined ? {} : { touches: [...options.touches] };
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
        createdAt: "2026-10-29",
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
        meta: {
          ...(options.kind === undefined ? {} : { kind: options.kind }),
          ...(Object.keys(parallel).length === 0 ? {} : { parallel }),
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeDelta(root: string, id: string, targets: readonly string[]): void {
  fs.writeFileSync(
    path.join(root, ".phronia/tasks", id, "spec-delta.md"),
    [
      "# Spec Delta",
      "",
      "## Target files",
      ...targets.map((target) => `- ${target}`),
      "",
      "## Intended changes",
      `- record the ${id} contract`,
      "",
      "## Rationale",
      "- the code landed",
      "",
      "## Verification",
      "- read the synced spec",
      "",
    ].join("\n"),
  );
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
    kind: "phronia";
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
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, worktrees }, null, 2),
  );
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

function readMeta(root: string, id: string): Record<string, unknown> {
  const task = JSON.parse(
    fs.readFileSync(path.join(root, ".phronia/tasks", id, "task.json"), "utf8"),
  ) as { meta?: Record<string, unknown> };
  return task.meta ?? {};
}

function runTask(
  root: string,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    "python3",
    [".phronia/scripts/task.py", ...args],
    { cwd: root, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function monthDir(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
