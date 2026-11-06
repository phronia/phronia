/**
 * `resolveWorktreeRoot` is the single place that decides where task worktrees
 * live. These cases pin the contract every other layer depends on: a stable
 * absolute path, a repo-relative form usable as a `.gitignore` pattern, and an
 * honest `outsideRepo` flag instead of a silently useless relative path.
 */

import { describe, expect, it } from "vitest";

import {
  WORKTREE_ROOT_DIR_NAME,
  resolveWorktreeRoot,
} from "../../src/index.js";

describe("resolveWorktreeRoot", () => {
  it("falls back to the layout default when no directory is configured", () => {
    const root = resolveWorktreeRoot({ mainRoot: "/repo" });
    expect(root).toEqual({
      absolute: `/repo/${WORKTREE_ROOT_DIR_NAME}`,
      relativeFromRepo: WORKTREE_ROOT_DIR_NAME,
      outsideRepo: false,
      source: "default",
    });
  });

  it("treats blank and whitespace-only values as unconfigured", () => {
    for (const configuredDir of ["", "   ", "\t"]) {
      expect(
        resolveWorktreeRoot({ configuredDir, mainRoot: "/repo" }).source,
      ).toBe("default");
    }
  });

  it("resolves a relative directory under the repository root", () => {
    const root = resolveWorktreeRoot({
      configuredDir: ".custom-wt",
      mainRoot: "/repo",
    });
    expect(root.absolute).toBe("/repo/.custom-wt");
    expect(root.relativeFromRepo).toBe(".custom-wt");
    expect(root.outsideRepo).toBe(false);
    expect(root.source).toBe("config");
  });

  it("keeps a nested relative directory verbatim", () => {
    const root = resolveWorktreeRoot({
      configuredDir: ".phronia/wt",
      mainRoot: "/repo",
    });
    expect(root.absolute).toBe("/repo/.phronia/wt");
    expect(root.relativeFromRepo).toBe(".phronia/wt");
  });

  it("collapses `.` and repeated separators in a relative directory", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "./.custom//wt/",
      mainRoot: "/repo",
    });
    expect(root.absolute).toBe("/repo/.custom/wt");
    expect(root.relativeFromRepo).toBe(".custom/wt");
  });

  it("uses an absolute directory as-is without prefixing the checkout", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "/mnt/worktrees",
      mainRoot: "/repo",
    });
    expect(root.absolute).toBe("/mnt/worktrees");
    expect(root.outsideRepo).toBe(true);
    expect(root.relativeFromRepo).toBeNull();
  });

  it("treats an absolute directory inside the repository as inside", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "/repo/wt",
      mainRoot: "/repo",
    });
    expect(root.outsideRepo).toBe(false);
    expect(root.relativeFromRepo).toBe("wt");
  });

  it("resolves a relative `..` escape as outside the repository", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "../repo-worktrees",
      mainRoot: "/parent/repo",
    });
    expect(root.absolute).toBe("/parent/repo-worktrees");
    expect(root.outsideRepo).toBe(true);
    expect(root.relativeFromRepo).toBeNull();
  });

  it("resolves sibling worktrees outside the repository without guessing a relative form", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "/code/bedrock-auth",
      mainRoot: "/code/bedrock",
    });
    expect(root.absolute).toBe("/code/bedrock-auth");
    expect(root.outsideRepo).toBe(true);
    expect(root.relativeFromRepo).toBeNull();
  });

  it("does not mistake a sibling sharing a name prefix for a child", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "/repo-other",
      mainRoot: "/repo",
    });
    expect(root.outsideRepo).toBe(true);
  });

  it("uses a platform temp root for ephemeral worktrees", () => {
    const root = resolveWorktreeRoot({
      configuredDir: ".ignored",
      mainRoot: "/repo",
      location: "ephemeral",
      tmpDir: "/var/tmp",
    });
    expect(root.absolute).toBe("/var/tmp/phronia-worktrees");
    expect(root.source).toBe("ephemeral");
    expect(root.outsideRepo).toBe(true);
  });

  it("normalizes Windows separators in a relative directory", () => {
    const root = resolveWorktreeRoot({
      configuredDir: ".custom\\wt",
      mainRoot: "C:/repo",
    });
    expect(root.absolute).toBe("C:/repo/.custom/wt");
    expect(root.relativeFromRepo).toBe(".custom/wt");
  });

  it("recognizes a Windows absolute directory", () => {
    const root = resolveWorktreeRoot({
      configuredDir: "D:\\worktrees",
      mainRoot: "C:/repo",
    });
    expect(root.absolute).toBe("D:/worktrees");
    expect(root.outsideRepo).toBe(true);
  });

  it("keeps the repository root when it is the POSIX root", () => {
    const root = resolveWorktreeRoot({ mainRoot: "/" });
    expect(root.absolute).toBe(`/${WORKTREE_ROOT_DIR_NAME}`);
    expect(root.relativeFromRepo).toBe(WORKTREE_ROOT_DIR_NAME);
  });
});

describe("resolveWorktreeRoot source provenance", () => {
  it("reports `default` when the caller forwards the built-in default", () => {
    const root = resolveWorktreeRoot({
      configuredDir: WORKTREE_ROOT_DIR_NAME,
      configuredDirSource: "default",
      mainRoot: "/repo",
    });
    expect(root.source).toBe("default");
    expect(root.relativeFromRepo).toBe(WORKTREE_ROOT_DIR_NAME);
  });

  it("reports `config` for a directory the user actually chose", () => {
    const root = resolveWorktreeRoot({
      configuredDir: ".custom-wt",
      configuredDirSource: "config",
      mainRoot: "/repo",
    });
    expect(root.source).toBe("config");
  });

  it("keeps `default` when no directory is supplied at all", () => {
    expect(resolveWorktreeRoot({ mainRoot: "/repo" }).source).toBe("default");
  });
});
