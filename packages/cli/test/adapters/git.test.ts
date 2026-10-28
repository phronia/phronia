import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitPort,
  GitError,
  type GitExec,
} from "../../src/adapters/git.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitPort", () => {
  it("reads status, branch, head, refs, and repository flags", () => {
    const { root } = makeRepo();
    const port = createGitPort();

    expect(port.status(root)).toEqual({ clean: true, dirtyPaths: 0 });
    expect(port.branch(root)).toBe("main");
    const first = port.head(root);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(port.resolveRef(root, "HEAD")).toBe(first);
    expect(port.isBare(root)).toBe(false);
    expect(port.isShallow(root)).toBe(false);
    expect(port.commonDir(root)).toBe(fs.realpathSync(path.join(root, ".git")));
    expect(port.mainWorktreeRoot(root)).toBe(root);

    fs.writeFileSync(path.join(root, "scratch.txt"), "dirty\n");
    expect(port.status(root)).toEqual({ clean: false, dirtyPaths: 1 });

    fs.appendFileSync(path.join(root, "README.md"), "\nsecond\n");
    runGit(root, ["add", "README.md"]);
    runGit(root, ["commit", "-q", "-m", "second"]);
    const second = port.head(root);
    expect(port.isAncestor(root, first, second)).toBe(true);
    expect(port.isAncestor(root, second, first)).toBe(false);
  });

  it("adds, lists, and removes linked worktrees", () => {
    const { root, base } = makeRepo();
    const port = createGitPort();
    const worktreePath = path.join(base, "wt");

    port.worktreeAdd({
      cwd: root,
      path: worktreePath,
      branch: "feature/x",
      base: "main",
      createBranch: true,
    });

    const list = port.worktreeList(root);
    expect(list).toHaveLength(2);
    const linked = list.find((entry) => entry.branch === "feature/x");
    expect(linked).toMatchObject({
      path: fs.realpathSync(worktreePath),
      bare: false,
      detached: false,
    });
    expect(port.commonDir(worktreePath)).toBe(
      fs.realpathSync(path.join(root, ".git")),
    );
    expect(port.mainWorktreeRoot(worktreePath)).toBe(root);

    port.worktreeRemove({ cwd: root, path: worktreePath });
    expect(port.worktreeList(root)).toHaveLength(1);
  });

  it("resolves a relative --git-common-dir against the cwd", () => {
    const exec: GitExec = (args) => {
      if (args.join(" ") === "rev-parse --git-common-dir") {
        return ok(".git\n");
      }
      return failure("unexpected command");
    };
    const port = createGitPort(exec);
    expect(port.commonDir("/repo/.phronia/worktrees/a")).toBe(
      "/repo/.phronia/worktrees/a/.git",
    );
  });

  it("parses porcelain worktree output including detached and locked entries", () => {
    const output = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/wt",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/feature/x",
      "locked maintenance",
      "",
      "worktree /repo/detached",
      "HEAD cccccccccccccccccccccccccccccccccccccccc",
      "detached",
      "",
    ].join("\n");
    const port = createGitPort(() => ok(output));

    expect(port.worktreeList("/repo")).toEqual([
      {
        path: "/repo",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "main",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/repo/wt",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        branch: "feature/x",
        bare: false,
        detached: false,
        locked: true,
        prunable: false,
      },
      {
        path: "/repo/detached",
        head: "cccccccccccccccccccccccccccccccccccccccc",
        branch: null,
        bare: false,
        detached: true,
        locked: false,
        prunable: false,
      },
    ]);
    expect(port.mainWorktreeRoot("/repo")).toBe("/repo");
  });

  it("reports a missing git binary as GIT_UNAVAILABLE", () => {
    const port = createGitPort(() => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: "ENOENT",
    }));
    expect(() => port.status("/repo")).toThrowError(GitError);
    try {
      port.status("/repo");
    } catch (error) {
      expect((error as GitError).code).toBe("GIT_UNAVAILABLE");
      expect((error as GitError).detail).toMatch(/unavailable/);
    }
  });

  it("returns structured rebase conflicts and supports abort", () => {
    const { root } = makeRepo();
    const port = createGitPort();

    runGit(root, ["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "README.md"), "# feature\n");
    runGit(root, ["commit", "-q", "-am", "feature change"]);

    runGit(root, ["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(root, "README.md"), "# main\n");
    runGit(root, ["commit", "-q", "-am", "main change"]);

    runGit(root, ["checkout", "-q", "feature"]);
    const result = port.rebase(root, "main");
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(["README.md"]);
    expect(result.detail).toMatch(/conflict/i);

    expect(port.rebaseAbort(root)).toEqual({ ok: true });
    expect(port.branch(root)).toBe("feature");
  });

  it("pushes, fetches, and fast-forwards with structured results", () => {
    const { root, base } = makeRepo();
    const port = createGitPort();
    const bare = path.join(base, "origin.git");
    runGit(base, ["init", "-q", "--bare", bare]);
    runGit(root, ["remote", "add", "origin", bare]);

    expect(port.push(root, "origin", "main")).toEqual({ ok: true });
    expect(port.fetch(root, "origin", "main")).toEqual({ ok: true });

    runGit(root, ["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "feature.txt"), "feature\n");
    runGit(root, ["add", "feature.txt"]);
    runGit(root, ["commit", "-q", "-m", "feature"]);
    const featureHead = port.head(root);
    expect(port.push(root, "origin", "feature")).toEqual({ ok: true });

    runGit(root, ["checkout", "-q", "main"]);
    expect(port.mergeFf(root, "feature")).toEqual({ ok: true });
    expect(port.head(root)).toBe(featureHead);

    const missing = port.push(root, "no-such-remote", "main");
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("GIT_FAILED");
    expect(missing.detail).toBeTruthy();
  });
});

function makeRepo(): { base: string; root: string } {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "phronia-git-adapter-")),
  );
  directories.push(base);
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

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ok(stdout: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: null;
} {
  return { exitCode: 0, stdout, stderr: "", timedOut: false, spawnError: null };
}

function failure(detail: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: null;
} {
  return {
    exitCode: 1,
    stdout: "",
    stderr: detail,
    timedOut: false,
    spawnError: null,
  };
}
