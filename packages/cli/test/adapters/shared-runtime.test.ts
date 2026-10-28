import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sharedRuntimePathsFromRoot } from "@phronia/core/state";
import { createGitPort } from "../../src/adapters/git.js";
import {
  ensureSharedRuntime,
  loadWorktreeRegistry,
  readRuntimeJson,
  resolveSharedRuntime,
  writeRuntimeJson,
} from "../../src/adapters/shared-runtime.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveSharedRuntime", () => {
  it("resolves <git-common-dir>/phronia from a real repository", () => {
    const { root } = makeRepo();
    const resolution = resolveSharedRuntime({
      cwd: root,
      git: createGitPort(),
    });

    expect(resolution.fallback).toBe(false);
    expect(resolution.commonDir).toBe(
      fs.realpathSync(path.join(root, ".git")),
    );
    expect(resolution.paths.root).toBe(
      path.join(fs.realpathSync(path.join(root, ".git")), "phronia"),
    );
    expect(resolution.diagnostics).toEqual([]);
  });

  it("falls back to the per-checkout runtime with a warning", () => {
    const cwd = makeDirectory("plain");
    const resolution = resolveSharedRuntime({
      cwd,
      git: {
        commonDir: () => {
          throw new Error("not a git repository");
        },
      },
    });

    expect(resolution.fallback).toBe(true);
    expect(resolution.commonDir).toBeNull();
    expect(resolution.paths.root).toBe(
      path.join(cwd, ".phronia", ".runtime"),
    );
    expect(resolution.diagnostics[0]?.code).toBe(
      "RUNTIME_SHARED_UNAVAILABLE",
    );
  });
});

describe("runtime directories and JSON files", () => {
  it("creates the root, leases, and logs directories", () => {
    const root = makeDirectory("runtime");
    const paths = sharedRuntimePathsFromRoot(root);

    const first = ensureSharedRuntime(paths);
    expect(first.ok).toBe(true);
    expect(first.created).toEqual([paths.leases, paths.logs]);
    expect(fs.existsSync(paths.leases)).toBe(true);
    expect(fs.existsSync(paths.logs)).toBe(true);

    const second = ensureSharedRuntime(paths);
    expect(second).toMatchObject({ ok: true, created: [] });
  });

  it("reads and writes schema-versioned JSON atomically", () => {
    const root = makeDirectory("runtime");
    const target = path.join(root, "worktrees.json");

    expect(readRuntimeJson(target)).toMatchObject({
      ok: false,
      missing: true,
      code: "RUNTIME_FILE_MISSING",
    });

    expect(
      writeRuntimeJson(target, { worktrees: [] }),
    ).toMatchObject({ ok: true });
    expect(readRuntimeJson<{ schemaVersion: number; worktrees: unknown[] }>(target)).toMatchObject({
      ok: true,
      value: { schemaVersion: 1, worktrees: [] },
    });
    expect(
      fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

    fs.writeFileSync(target, "{not json", "utf8");
    expect(readRuntimeJson(target)).toMatchObject({
      ok: false,
      code: "RUNTIME_FILE_INVALID",
    });

    fs.writeFileSync(target, JSON.stringify({ schemaVersion: 9 }), "utf8");
    expect(readRuntimeJson(target)).toMatchObject({
      ok: false,
      code: "RUNTIME_SCHEMA_UNSUPPORTED",
    });

    expect(writeRuntimeJson(target, { schemaVersion: 9 })).toMatchObject({
      ok: false,
      code: "RUNTIME_SCHEMA_UNSUPPORTED",
    });
    expect(writeRuntimeJson(target, 42)).toMatchObject({
      ok: false,
      code: "RUNTIME_FILE_INVALID",
    });
  });
});

describe("loadWorktreeRegistry", () => {
  it("migrates the legacy registry into the shared location", () => {
    const { root } = makeRepo();
    const resolution = resolveSharedRuntime({
      cwd: root,
      git: createGitPort(),
    });
    const legacy = path.join(root, ".phronia", ".runtime", "worktrees.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        schemaVersion: 1,
        worktrees: [
          {
            taskRef: ".phronia/tasks/a",
            path: "/repo/.phronia/worktrees/a",
            branch: "phronia/a",
            createdAt: "2026-10-28T09:00:00Z",
          },
          {
            taskRef: ".phronia/tasks/b",
            path: "/repo/.phronia/worktrees/b",
            branch: "phronia/b",
            taskId: "b",
          },
        ],
      }),
      "utf8",
    );
    const legacyBefore = fs.readFileSync(legacy, "utf8");

    const first = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      write: true,
    });
    expect(first.migrated).toBe(true);
    expect(first.rebuilt).toBe(false);
    expect(first.wrote).toBe(true);
    expect(first.registry.worktrees).toHaveLength(2);
    expect(first.registry.worktrees[0]).toMatchObject({
      taskRef: ".phronia/tasks/a",
      kind: "phronia",
      createdAt: "2026-10-28T09:00:00Z",
    });
    expect(first.registry.worktrees[1]).toMatchObject({
      taskRef: ".phronia/tasks/b",
      taskId: "b",
    });

    const shared = JSON.parse(
      fs.readFileSync(resolution.paths.worktrees, "utf8"),
    ) as { schemaVersion: number; worktrees: unknown[] };
    expect(shared.schemaVersion).toBe(1);
    expect(shared.worktrees).toHaveLength(2);
    // The legacy file is left untouched for rollback.
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyBefore);

    const second = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      write: true,
    });
    expect(second.migrated).toBe(false);
    expect(second.rebuilt).toBe(false);
    expect(second.wrote).toBe(false);
    expect(second.registry.worktrees).toHaveLength(2);
  });

  it("keeps shared entries when the legacy registry conflicts", () => {
    const { root } = makeRepo();
    const resolution = resolveSharedRuntime({
      cwd: root,
      git: createGitPort(),
    });
    writeRuntimeJson(resolution.paths.worktrees, {
      schemaVersion: 1,
      worktrees: [
        {
          taskRef: ".phronia/tasks/a",
          path: "/shared/a",
          branch: "phronia/a",
          kind: "phronia",
        },
      ],
    });
    const legacy = path.join(root, ".phronia", ".runtime", "worktrees.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        schemaVersion: 1,
        worktrees: [
          { taskRef: ".phronia/tasks/a", path: "/legacy/a", branch: "old/a" },
          { taskRef: ".phronia/tasks/c", path: "/legacy/c", branch: "phronia/c" },
        ],
      }),
      "utf8",
    );

    const loaded = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      write: true,
    });
    expect(loaded.migrated).toBe(true);
    expect(loaded.registry.worktrees).toHaveLength(2);
    const entryA = loaded.registry.worktrees.find(
      (entry) => entry.taskRef === ".phronia/tasks/a",
    );
    expect(entryA?.path).toBe("/shared/a");
    expect(
      loaded.registry.worktrees.some(
        (entry) => entry.taskRef === ".phronia/tasks/c",
      ),
    ).toBe(true);
  });

  it("drops merged entries that git no longer reports (git wins)", () => {
    const { root, base } = makeRepo();
    const port = createGitPort();
    const worktreePath = path.join(base, "wt-keep");
    port.worktreeAdd({
      cwd: root,
      path: worktreePath,
      branch: "phronia/keep",
      base: "main",
      createBranch: true,
    });
    const resolution = resolveSharedRuntime({ cwd: root, git: port });
    writeRuntimeJson(resolution.paths.worktrees, {
      schemaVersion: 1,
      worktrees: [
        {
          taskRef: ".phronia/tasks/keep",
          path: fs.realpathSync(worktreePath),
          branch: "phronia/keep",
          kind: "phronia",
        },
        {
          taskRef: ".phronia/tasks/gone",
          path: path.join(base, "gone"),
          branch: "phronia/gone",
          kind: "phronia",
        },
      ],
    });
    const legacy = path.join(root, ".phronia", ".runtime", "worktrees.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        schemaVersion: 1,
        worktrees: [
          {
            taskRef: ".phronia/tasks/legacy-gone",
            path: path.join(base, "legacy-gone"),
            branch: "phronia/legacy-gone",
          },
        ],
      }),
      "utf8",
    );

    const loaded = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      git: port,
      write: true,
    });

    expect(loaded.migrated).toBe(false);
    expect(loaded.rebuilt).toBe(false);
    expect(loaded.wrote).toBe(true);
    expect(loaded.registry.worktrees).toEqual([
      expect.objectContaining({ taskRef: ".phronia/tasks/keep" }),
    ]);
    expect(
      loaded.diagnostics.some(
        (item) => item.code === "RUNTIME_WORKTREES_PRUNED",
      ),
    ).toBe(true);

    const shared = JSON.parse(
      fs.readFileSync(resolution.paths.worktrees, "utf8"),
    ) as { worktrees: unknown[] };
    expect(shared.worktrees).toHaveLength(1);

    // The stale legacy entry is still in the old file, but it never enters the
    // shared registry, so a second load must not rewrite it.
    const second = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      git: port,
      write: true,
    });
    expect(second.migrated).toBe(false);
    expect(second.wrote).toBe(false);
    expect(second.registry.worktrees).toHaveLength(1);
  });

  it("keeps merged entries and warns when git cannot verify them", () => {
    const { root, base } = makeRepo();
    const resolution = resolveSharedRuntime({
      cwd: root,
      git: createGitPort(),
    });
    writeRuntimeJson(resolution.paths.worktrees, {
      schemaVersion: 1,
      worktrees: [
        {
          taskRef: ".phronia/tasks/a",
          path: path.join(base, "a"),
          branch: "phronia/a",
          kind: "phronia",
        },
      ],
    });
    const legacy = path.join(root, ".phronia", ".runtime", "worktrees.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        schemaVersion: 1,
        worktrees: [
          {
            taskRef: ".phronia/tasks/b",
            path: path.join(base, "b"),
            branch: "phronia/b",
          },
        ],
      }),
      "utf8",
    );

    const loaded = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      git: {
        worktreeList: () => {
          throw new Error("git unavailable");
        },
      },
      write: true,
    });

    expect(loaded.registry.worktrees).toHaveLength(2);
    expect(
      loaded.diagnostics.some(
        (item) => item.code === "RUNTIME_WORKTREES_UNVERIFIED",
      ),
    ).toBe(true);
    expect(
      loaded.diagnostics.some(
        (item) => item.code === "RUNTIME_WORKTREES_PRUNED",
      ),
    ).toBe(false);
  });

  it("rebuilds from git worktree list when no registry exists", () => {
    const { root, base } = makeRepo();
    const port = createGitPort();
    const worktreePath = path.join(base, "wt");
    port.worktreeAdd({
      cwd: root,
      path: worktreePath,
      branch: "phronia/demo",
      base: "main",
      createBranch: true,
    });
    const platformPath = path.join(base, "platform");
    port.worktreeAdd({
      cwd: root,
      path: platformPath,
      branch: "platform/other",
      base: "main",
      createBranch: true,
    });

    const resolution = resolveSharedRuntime({ cwd: root, git: port });
    const loaded = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      git: port,
      write: true,
    });

    expect(loaded.rebuilt).toBe(true);
    expect(loaded.migrated).toBe(false);
    expect(loaded.wrote).toBe(true);
    expect(loaded.registry.worktrees).toHaveLength(2);

    const phronia = loaded.registry.worktrees.find(
      (entry) => entry.branch === "phronia/demo",
    );
    expect(phronia).toMatchObject({
      taskRef: ".phronia/tasks/demo",
      kind: "phronia",
    });
    expect(phronia?.provisional).toBeUndefined();
    const platform = loaded.registry.worktrees.find(
      (entry) => entry.branch === "platform/other",
    );
    expect(platform).toMatchObject({
      taskRef: "",
      kind: "platform",
      provisional: true,
    });
    // The main worktree is never part of the registry.
    expect(
      loaded.registry.worktrees.some(
        (entry) => path.resolve(entry.path) === root,
      ),
    ).toBe(false);

    const second = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      git: port,
      write: true,
    });
    expect(second.rebuilt).toBe(false);
    expect(second.wrote).toBe(false);
  });

  it("does not write when write is false", () => {
    const { root } = makeRepo();
    const resolution = resolveSharedRuntime({
      cwd: root,
      git: createGitPort(),
    });
    const loaded = loadWorktreeRegistry({
      projectRoot: root,
      paths: resolution.paths,
      git: createGitPort(),
      write: false,
    });
    expect(loaded.wrote).toBe(false);
    expect(fs.existsSync(resolution.paths.worktrees)).toBe(false);
  });
});

function makeRepo(): { base: string; root: string } {
  const base = makeDirectory("repo");
  const root = path.join(base, "repo");
  fs.mkdirSync(root);
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  return { base, root };
}

function makeDirectory(prefix: string): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `phronia-${prefix}-`)),
  );
  directories.push(directory);
  return directory;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
