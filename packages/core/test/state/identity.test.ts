import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFs } from "../../src/state/fs.js";
import { readDeveloper, readJournal, countLines } from "../../src/state/identity.js";
import {
  readGitState,
  mainWorktreeRoot,
  resetGitCache,
  type GitExec,
} from "../../src/state/git.js";

describe("developer identity", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-identity-"));
    resetGitCache();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetGitCache();
  });

  it("prefers the environment override", () => {
    fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/.developer"), "name=local\n");
    const state = readDeveloper(root, nodeFs, {
      env: { PHRONIA_DEVELOPER: "env" },
    });
    expect(state).toMatchObject({ name: "env", source: "env" });
  });

  it("reads the local .developer file", () => {
    fs.mkdirSync(path.join(root, ".phronia"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/.developer"), "name=local\n");
    expect(readDeveloper(root, nodeFs, { env: {} })).toMatchObject({
      name: "local",
      source: "local",
    });
  });

  it("inherits from the main worktree when this is a linked worktree", () => {
    const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-main-"));
    try {
      fs.mkdirSync(path.join(mainRoot, ".phronia"), { recursive: true });
      fs.writeFileSync(path.join(mainRoot, ".phronia/.developer"), "name=main\n");
      const exec: GitExec = (args) => {
        if (args[0] === "worktree") {
          return {
            status: 0,
            stdout: `worktree ${mainRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${root}\nHEAD def\nbranch refs/heads/feature\n`,
            stderr: "",
          };
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: `${root}\n`, stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      };
      expect(readDeveloper(root, nodeFs, { env: {}, exec })).toMatchObject({
        name: "main",
        source: "main-worktree",
      });
    } finally {
      fs.rmSync(mainRoot, { recursive: true, force: true });
    }
  });

  it("reports a missing identity", () => {
    const state = readDeveloper(root, nodeFs, { env: {} });
    expect(state.name).toBeNull();
    expect(state.diagnostics.map((item) => item.code)).toContain("state.identity.missing");
  });
});

describe("journal", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-journal-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("picks the highest-numbered journal and counts Python-style lines", () => {
    const dir = path.join(root, ".phronia/workspace/alice");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "journal-1.md"), "one\ntwo\n");
    fs.writeFileSync(path.join(dir, "journal-2.md"), "a\nb\nc\n");
    fs.writeFileSync(path.join(dir, "index.md"), "- row\n");
    const state = readJournal(root, "alice", nodeFs);
    expect(state.file).toBe(".phronia/workspace/alice/journal-2.md");
    expect(state.lineCount).toBe(3);
  });

  it("matches splitlines for empty and trailing-newline content", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\r\nb\r\n")).toBe(2);
  });
});

describe("git state", () => {
  it("reports branch and dirty paths", () => {
    const exec: GitExec = (args) => {
      if (args[0] === "branch") {
        return { status: 0, stdout: "main\n", stderr: "" };
      }
      return { status: 0, stdout: " M a.ts\n?? b.ts\n", stderr: "" };
    };
    expect(readGitState("/repo", exec)).toEqual({
      branch: "main",
      dirtyPaths: 2,
      clean: false,
    });
  });

  it("fails soft when git is unavailable", () => {
    const exec: GitExec = () => ({ status: 1, stdout: "", stderr: "no git" });
    expect(readGitState("/repo", exec)).toEqual({
      branch: "",
      dirtyPaths: null,
      clean: null,
    });
  });

  it("detects a linked worktree and refuses bare main trees", () => {
    resetGitCache();
    const mainRoot = "/repo/main";
    const exec: GitExec = (args) => {
      if (args[0] === "worktree") {
        return {
          status: 0,
          stdout: `worktree ${mainRoot}\nHEAD abc\nbranch refs/heads/main\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "/repo/linked\n", stderr: "" };
    };
    expect(mainWorktreeRoot("/repo/linked", exec)).toBe(mainRoot);

    const bareExec: GitExec = (args) => {
      if (args[0] === "worktree") {
        return { status: 0, stdout: "worktree /repo/bare.git\nbare\n", stderr: "" };
      }
      return { status: 0, stdout: "/repo/bare.git\n", stderr: "" };
    };
    resetGitCache();
    expect(mainWorktreeRoot("/repo/bare.git", bareExec)).toBeNull();
  });
});
