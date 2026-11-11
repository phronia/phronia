import { describe, expect, it } from "vitest";

import {
  resolveWorktreeBase,
  type BaseRefFacts,
} from "../../src/task/workspace/base.js";

const COMMITS: Record<string, string> = {
  main: "c-main",
  master: "c-master",
  "origin/main": "c-origin-main",
  "origin/master": "c-origin-master",
  "origin/develop": "c-origin-develop",
  HEAD: "c-head",
  "fix/base": "c-fix",
};

function facts(overrides: Partial<BaseRefFacts> = {}): BaseRefFacts {
  return {
    mode: "auto",
    confirm: "auto",
    localMain: "main",
    localMaster: "master",
    localIntegration: "main",
    resolveRef: (ref) => COMMITS[ref] ?? null,
    compare: (base, local) =>
      base === "origin/main" && local === "main"
        ? { ahead: 1, behind: 2 }
        : { ahead: 0, behind: 0 },
    ...overrides,
  };
}

describe("resolveWorktreeBase", () => {
  it("lets --base win over every configured source", () => {
    const result = resolveWorktreeBase(
      facts({
        cliBase: "fix/base",
        taskBaseBranch: "master",
        configBranch: "master",
        remoteMain: "origin/main",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      ref: "fix/base",
      commit: "c-fix",
      source: "cli",
      remote: false,
      freshness: "local",
      shouldAsk: false,
    });
  });

  it("prefers task.base_branch over the integration config", () => {
    const result = resolveWorktreeBase(
      facts({ taskBaseBranch: "master", configBranch: "main" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toBe("master");
    expect(result.source).toBe("task");
  });

  it("prefers the integration config over remote auto-detection", () => {
    const result = resolveWorktreeBase(
      facts({ configBranch: "master", remoteMain: "origin/main" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toBe("master");
    expect(result.source).toBe("config");
    expect(result.remote).toBe(false);
  });

  it("prefers origin/HEAD over origin/main and origin/master", () => {
    const result = resolveWorktreeBase(
      facts({
        remoteHead: "origin/develop",
        remoteMain: "origin/main",
        remoteMaster: "origin/master",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toBe("origin/develop");
    expect(result.source).toBe("remote-head");
    expect(result.remote).toBe(true);
  });

  it("falls back from origin/main to origin/master", () => {
    const result = resolveWorktreeBase(
      facts({ remoteMain: "origin/main", remoteMaster: "origin/master" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toBe("origin/main");
  });

  it("uses local main in local mode even when remote refs exist", () => {
    const result = resolveWorktreeBase(
      facts({
        mode: "local",
        remoteMain: "origin/main",
        localMain: "main",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toBe("main");
    expect(result.source).toBe("local-integration");
    expect(result.remote).toBe(false);
  });

  it("refuses remote mode without an origin ref", () => {
    const result = resolveWorktreeBase(facts({ mode: "remote" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WORKTREE_BASE_REMOTE_UNAVAILABLE");
    expect(result.next).toContain("--base");
  });

  it("refuses instead of silently using main", () => {
    const result = resolveWorktreeBase(
      facts({ localMain: null, localMaster: null, localIntegration: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WORKTREE_BASE_UNRESOLVED");
    expect(result.next).toContain("--base");
  });

  it("refuses an unknown --base instead of falling through", () => {
    const result = resolveWorktreeBase(facts({ cliBase: "does-not-exist" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WORKTREE_BASE_INVALID");
  });

  it("treats an explicit HEAD as the head source", () => {
    const result = resolveWorktreeBase(facts({ cliBase: "HEAD" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("head");
    expect(result.remote).toBe(false);
    expect(result.freshness).toBe("local");
  });

  it("reports ahead/behind and asks about a remote base", () => {
    const result = resolveWorktreeBase(
      facts({ remoteMain: "origin/main", localIntegration: "main" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      behind: 2,
      ahead: 1,
      freshness: "unverified",
      shouldAsk: true,
    });
    expect(result.alternatives).toContain("main");
  });

  it("does not ask for a local base", () => {
    const result = resolveWorktreeBase(facts({ localMain: "main" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shouldAsk).toBe(false);
    expect(result.freshness).toBe("local");
  });

  it("honors confirm=always and confirm=never", () => {
    const always = resolveWorktreeBase(
      facts({ localMain: "main", confirm: "always" }),
    );
    expect(always.ok && always.shouldAsk).toBe(true);

    const never = resolveWorktreeBase(
      facts({ remoteMain: "origin/main", confirm: "never" }),
    );
    expect(never.ok && never.shouldAsk).toBe(false);
  });

  it("marks a fetched remote base as verified", () => {
    const result = resolveWorktreeBase(
      facts({ remoteMain: "origin/main", freshness: "fetched" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.freshness).toBe("fetched");
  });
});
