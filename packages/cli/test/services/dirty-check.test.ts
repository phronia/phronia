import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitPort } from "../../src/adapters/git.js";
import {
  parseStatusLine,
  readDirtyPaths,
} from "../../src/services/dirty-check.js";

describe("filtered dirty check (parallel.integration.ignored_inputs)", () => {
  let root: string;
  const gitPort = createGitPort();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-dirty-"));
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "cache/\n");
    fs.mkdirSync(path.join(root, "cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "cache", "artifact.bin"), "cached\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ignores a configured symlink to a gitignored directory", () => {
    fs.symlinkSync(path.join(root, "cache"), path.join(root, "sdk-pin"), "dir");

    const withoutConfig = readDirtyPaths(gitPort, root, [], root);
    expect(withoutConfig.dirtyPaths).toEqual(["sdk-pin"]);

    const configured = readDirtyPaths(gitPort, root, ["sdk-pin"], root);
    expect(configured.dirtyPaths).toEqual([]);
    expect(configured.ignoredPaths).toEqual(["sdk-pin"]);
    expect(configured.warning).toBeNull();
  });

  it("ignores a configured tracked path only when git ignores it", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "cache/\ngenerated.txt\n");
    fs.writeFileSync(path.join(root, "generated.txt"), "v1\n");
    git(root, ["add", "-A"]);
    git(root, ["add", "-f", "generated.txt"]);
    git(root, ["commit", "-q", "-m", "generated"]);
    fs.writeFileSync(path.join(root, "generated.txt"), "v2\n");

    const result = readDirtyPaths(gitPort, root, ["generated.txt"], root);
    expect(result.dirtyPaths).toEqual([]);
    expect(result.ignoredPaths).toEqual(["generated.txt"]);
  });

  it("keeps a configured regular untracked file dirty and warns", () => {
    fs.writeFileSync(path.join(root, "real.txt"), "x\n");

    const result = readDirtyPaths(gitPort, root, ["real.txt"], root);
    expect(result.dirtyPaths).toEqual(["real.txt"]);
    expect(result.ignoredPaths).toEqual([]);
    expect(result.warning).toContain("neither a symlink nor git-ignored");
  });

  it("keeps an undeclared symlink dirty", () => {
    fs.symlinkSync(path.join(root, "README.md"), path.join(root, "alias.md"));

    const result = readDirtyPaths(gitPort, root, ["other-input"], root);
    expect(result.dirtyPaths).toEqual(["alias.md"]);
  });

  it("does not blanket-ignore an untracked directory input", () => {
    fs.mkdirSync(path.join(root, "deps", "nested"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "cache"),
      path.join(root, "deps", "nested", "sdk-pin"),
      "dir",
    );

    // Git reports the untracked directory as `deps/`. The configured input
    // covers it by prefix, but the directory is neither a symlink nor ignored,
    // so the safety check keeps it dirty.
    const result = readDirtyPaths(gitPort, root, ["deps"], root);
    expect(result.dirtyPaths).toHaveLength(1);
    expect(result.dirtyPaths[0]).toMatch(/^deps\/?$/);
    expect(result.ignoredPaths).toEqual([]);
    expect(result.warning).toContain("neither a symlink nor git-ignored");
  });

  it("keeps a configured symlink that resolves outside the repo dirty", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "payload"), "x\n");
      fs.symlinkSync(outside, path.join(root, "sdk-pin"), "dir");

      const result = readDirtyPaths(gitPort, root, ["sdk-pin"], root);
      expect(result.dirtyPaths).toEqual(["sdk-pin"]);
      expect(result.ignoredPaths).toEqual([]);
      expect(result.warning).toContain("escapes the repository");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a configured symlink that resolves to a repo directory", () => {
    const modules = path.join(root, "cache", "node_modules");
    fs.mkdirSync(path.join(modules, "dep"), { recursive: true });
    fs.writeFileSync(path.join(modules, "dep", "index.js"), "x\n");
    fs.symlinkSync(modules, path.join(root, "deps-link"), "dir");

    const result = readDirtyPaths(gitPort, root, ["deps-link"], root);
    expect(result.dirtyPaths).toEqual([]);
    expect(result.ignoredPaths).toEqual(["deps-link"]);
    expect(result.warning).toBeNull();
  });

  it("parses rename and quoted porcelain lines", () => {
    expect(parseStatusLine('R  "old name.txt" -> "new name.txt"')?.path).toBe(
      "new name.txt",
    );
    expect(parseStatusLine("?? plain.txt")?.path).toBe("plain.txt");
    expect(parseStatusLine("R  old.txt -> new.txt")?.path).toBe("new.txt");
    expect(parseStatusLine("?? \"tab\\there.txt\"")?.path).toBe(
      "tab\there.txt",
    );
    expect(parseStatusLine("??")).toBeNull();
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
