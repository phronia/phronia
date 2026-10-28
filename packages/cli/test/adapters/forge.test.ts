import { describe, expect, it } from "vitest";
import type { CommandExec, CommandResult } from "../../src/adapters/git.js";
import {
  createForgePort,
  parseOriginUrl,
} from "../../src/adapters/forge.js";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

describe("origin parsing", () => {
  it("parses scp-like, ssh, and https remotes", () => {
    expect(parseOriginUrl("git@github.com:acme/app.git")).toMatchObject({
      kind: "github",
      host: "github.com",
      owner: "acme",
      repo: "app",
      webBase: "https://github.com",
    });
    expect(
      parseOriginUrl("https://gitlab.com/group/sub/app.git"),
    ).toMatchObject({
      kind: "gitlab",
      owner: "group/sub",
      repo: "app",
    });
    expect(
      parseOriginUrl("ssh://git@gitlab.example.com:2222/group/app.git"),
    ).toMatchObject({
      kind: "gitlab",
      host: "gitlab.example.com",
      owner: "group",
      repo: "app",
    });
    expect(parseOriginUrl("https://code.example.com/acme/app")).toMatchObject({
      kind: "generic",
      host: "code.example.com",
    });
  });

  it("rejects unusable remotes", () => {
    expect(parseOriginUrl("")).toBeNull();
    expect(parseOriginUrl("https://github.com")).toBeNull();
    expect(parseOriginUrl("not-a-remote")).toBeNull();
  });
});

describe("ForgePort", () => {
  it("detects GitHub, probes gh once, and creates a PR without merging", () => {
    const { exec, calls } = scripted((file, args) => {
      if (file === "gh" && args[0] === "--version") {
        return result(file, 0, "gh version 2.40.0\n");
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "create") {
        return result(file, 0, "https://github.com/acme/app/pull/7\n");
      }
      return result(file, 1, "", "unexpected command");
    });
    const forge = createForgePort({
      cwd: "/repo",
      originUrl: "git@github.com:acme/app.git",
      exec,
    });

    expect(forge.kind).toBe("github");
    expect(forge.available()).toBe(true);
    expect(forge.available()).toBe(true);
    expect(
      calls.filter((call) => call.args[0] === "--version"),
    ).toHaveLength(1);

    const created = forge.createChangeRequest({
      branch: "feature/x",
      base: "main",
      title: "Add widget",
      body: "Body",
      draft: true,
    });
    expect(created).toEqual({
      url: "https://github.com/acme/app/pull/7",
    });

    const create = calls.find(
      (call) => call.file === "gh" && call.args[1] === "create",
    );
    expect(create?.args).toEqual(
      expect.arrayContaining([
        "--head",
        "feature/x",
        "--base",
        "main",
        "--title",
        "Add widget",
        "--body",
        "Body",
        "--draft",
      ]),
    );
    expect(calls.some((call) => call.args.includes("merge"))).toBe(false);
  });

  it("uses glab for GitLab and normalizes provider state", () => {
    const { exec, calls } = scripted((file, args) => {
      if (file === "glab" && args[0] === "--version") {
        return result(file, 0, "glab version 1.40.0\n");
      }
      if (file === "glab" && args[0] === "mr" && args[1] === "create") {
        return result(file, 0, "https://gitlab.com/group/app/-/merge_requests/3\n");
      }
      if (file === "glab" && args[0] === "mr" && args[1] === "view") {
        return result(
          file,
          0,
          JSON.stringify({
            web_url: "https://gitlab.com/group/app/-/merge_requests/3",
            state: "opened",
            source_branch: "feature/x",
            draft: true,
          }),
        );
      }
      return result(file, 1, "", "unexpected command");
    });
    const forge = createForgePort({
      cwd: "/repo",
      originUrl: "https://gitlab.com/group/app.git",
      exec,
    });

    expect(forge.kind).toBe("gitlab");
    expect(
      forge.createChangeRequest({
        branch: "feature/x",
        base: "main",
        title: "Add widget",
      }),
    ).toEqual({
      url: "https://gitlab.com/group/app/-/merge_requests/3",
    });
    expect(forge.viewChangeRequest("feature/x")).toEqual({
      url: "https://gitlab.com/group/app/-/merge_requests/3",
      state: "open",
      branch: "feature/x",
      draft: true,
      mergeState: null,
    });

    const create = calls.find(
      (call) => call.file === "glab" && call.args[1] === "create",
    );
    expect(create?.args).toEqual(
      expect.arrayContaining([
        "--source-branch",
        "feature/x",
        "--target-branch",
        "main",
        "--yes",
      ]),
    );
    expect(calls.some((call) => call.args.includes("merge"))).toBe(false);
  });

  it("returns null when the forge CLI is unavailable", () => {
    const { exec } = scripted((file) =>
      result(file, 0, "", "", "ENOENT"),
    );
    const forge = createForgePort({
      cwd: "/repo",
      originUrl: "git@github.com:acme/app.git",
      exec,
    });
    expect(forge.available()).toBe(false);
    expect(
      forge.createChangeRequest({
        branch: "feature/x",
        base: "main",
        title: "T",
      }),
    ).toBeNull();
    expect(forge.viewChangeRequest("feature/x")).toBeNull();
  });

  it("reads the origin URL from git when not supplied", () => {
    const { exec, calls } = scripted((file, args) => {
      if (file === "git" && args.join(" ") === "remote get-url origin") {
        return result(file, 0, "https://github.com/acme/app.git\n");
      }
      if (file === "gh" && args[0] === "--version") {
        return result(file, 0, "gh version 2.40.0\n");
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        return result(
          file,
          0,
          JSON.stringify({
            url: "https://github.com/acme/app/pull/9",
            state: "MERGED",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            headRefName: "feature/x",
          }),
        );
      }
      return result(file, 1, "", "unexpected command");
    });

    const forge = createForgePort({ cwd: "/repo", exec });
    expect(forge.kind).toBe("github");
    expect(forge.available()).toBe(true);
    expect(forge.viewChangeRequest("feature/x")).toEqual({
      url: "https://github.com/acme/app/pull/9",
      state: "merged",
      branch: "feature/x",
      draft: false,
      mergeState: "CLEAN",
    });
    expect(calls[0]).toMatchObject({ file: "git", timeoutMs: 3000 });
  });

  it("degrades to null on invalid view output", () => {
    const { exec } = scripted((file, args) => {
      if (args[0] === "--version") {
        return result(file, 0, "gh version\n");
      }
      return result(file, 0, "not json");
    });
    const forge = createForgePort({
      cwd: "/repo",
      originUrl: "git@github.com:acme/app.git",
      exec,
    });
    expect(forge.viewChangeRequest("feature/x")).toBeNull();
  });

  it("builds compare URLs for GitHub and GitLab only", () => {
    const github = createForgePort({
      cwd: "/repo",
      originUrl: "git@github.com:acme/app.git",
      exec: scripted(() => result("gh", 1, "", "")).exec,
    });
    expect(
      github.compareUrl({ base: "main", head: "feature/x" }),
    ).toBe("https://github.com/acme/app/compare/main...feature/x?expand=1");

    const gitlab = createForgePort({
      cwd: "/repo",
      originUrl: "https://gitlab.com/group/sub/app.git",
      exec: scripted(() => result("glab", 1, "", "")).exec,
    });
    expect(gitlab.compareUrl({ base: "main", head: "feature/x" })).toBe(
      "https://gitlab.com/group/sub/app/-/compare/main...feature/x",
    );

    const generic = createForgePort({
      cwd: "/repo",
      originUrl: "https://code.example.com/acme/app.git",
      exec: scripted(() => result("git", 1, "", "")).exec,
    });
    expect(generic.kind).toBe("generic");
    expect(generic.available()).toBe(false);
    expect(generic.compareUrl({ base: "main", head: "feature/x" })).toBeNull();
    expect(github.compareUrl({ base: "", head: "feature/x" })).toBeNull();

    const noOrigin = createForgePort({
      cwd: "/repo",
      originUrl: null,
      exec: scripted(() => result("git", 1, "", "")).exec,
    });
    expect(noOrigin.kind).toBe("generic");
    expect(noOrigin.compareUrl({ base: "main", head: "feature/x" })).toBeNull();
  });
});

function scripted(
  handler: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => CommandResult,
): { exec: CommandExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: CommandExec = (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    return handler(file, args, options.timeoutMs);
  };
  return { exec, calls };
}

function result(
  file: string,
  exitCode: number,
  stdout = "",
  stderr = "",
  spawnError: string | null = null,
  timedOut = false,
): CommandResult {
  return { file, exitCode, stdout, stderr, timedOut, spawnError };
}
