import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FsLike } from "../../src/state/fs.js";
import {
  gitCommonDir,
  type GitExec,
  type GitResult,
} from "../../src/state/git.js";
import {
  readRuntimeFacts,
  type RuntimeFacts,
} from "../../src/state/runtime-facts.js";
import {
  sharedRuntimePaths,
  taskLeasePath,
} from "../../src/state/shared-runtime.js";

const NOW = Date.parse("2026-10-28T01:00:00.000Z") / 1000;
const CLAIM_PATH = "/repo/.git/phronia/workspace.claim.json";

function gitResult(stdout = "", status = 0): GitResult {
  return { status, stdout, stderr: status === 0 ? "" : "git failed" };
}

function memoryFs(files: Readonly<Record<string, string>>): FsLike {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    let dir = path.posix.dirname(file);
    while (dir !== "/" && dir !== ".") {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
    dirs.add("/");
  }
  const errno = (code: string): Error => {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    return error;
  };
  return {
    existsSync: (target) =>
      Object.hasOwn(files, target) || dirs.has(target),
    readFileSync: (target) => {
      const value = files[target];
      if (value === undefined) {
        throw errno("ENOENT");
      }
      return value;
    },
    readdirSync: (target) => {
      if (!dirs.has(target)) {
        throw errno("ENOENT");
      }
      return Object.keys(files)
        .filter((file) => path.posix.dirname(file) === target)
        .map((file) => path.posix.basename(file))
        .sort();
    },
    statSync: (target) => {
      if (dirs.has(target)) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (Object.hasOwn(files, target)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw errno("ENOENT");
    },
    realpathSync: (target) => {
      if (!dirs.has(target) && !Object.hasOwn(files, target)) {
        throw errno("ENOENT");
      }
      return target;
    },
  };
}

/** Standard main checkout: a real `.git` directory with a branch HEAD. */
function standardFiles(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { "/repo/.git/HEAD": "ref: refs/heads/main\n", ...extra };
}

interface Recorder {
  readonly exec: GitExec;
  readonly calls: string[];
}

function throwingExec(): Recorder {
  const calls: string[] = [];
  return {
    calls,
    exec: (args) => {
      calls.push(args.join(" "));
      throw new Error("git must not be called on the fast path");
    },
  };
}

function recordingExec(handler: (key: string) => GitResult): Recorder {
  const calls: string[] = [];
  return {
    calls,
    exec: (args) => {
      const key = args.join(" ");
      calls.push(key);
      return handler(key);
    },
  };
}

function claimFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    ownerType: "task",
    ownerRef: "task:leaf",
    sessionKey: "session-1",
    taskRef: ".phronia/tasks/10-28-leaf",
    workspace: "/repo",
    branch: "main",
    host: "host",
    pid: 1,
    state: "in_progress",
    acquiredAt: "2026-10-27T23:00:00.000Z",
    heartbeatAt: "2026-10-27T23:00:00.000Z",
    ttlSeconds: 3600,
    ...overrides,
  });
}

function leaseFile(taskRef: string, ownerId: string, heartbeatAt: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    taskRef,
    ownerType: "session",
    ownerId,
    sessionKey: ownerId,
    workspace: "/repo",
    acquiredAt: heartbeatAt,
    heartbeatAt,
    ttlSeconds: 60,
  });
}

function codes(facts: RuntimeFacts): readonly string[] {
  return facts.diagnostics.map((item) => item.code);
}

describe("readRuntimeFacts fast layout", () => {
  it("reads a standard checkout with zero git calls", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles()),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.mainRoot).toBe("/repo");
    expect(facts.toplevel).toBe("/repo");
    expect(facts.isLinkedWorktree).toBe(false);
    expect(facts.branch).toBe("main");
    expect(facts.mainDirty).toBeNull();
    expect(facts.factsReliable).toBe(true);
    expect(codes(facts)).toEqual(
      expect.arrayContaining([
        "state.runtime.claim_missing",
        "state.runtime.worktrees_missing",
        "state.runtime.leases_missing",
      ]),
    );
  });

  it("reads a linked worktree layout with zero git calls", () => {
    const root = "/repo/.phronia/worktrees/10-28-leaf";
    const facts = readRuntimeFacts({
      root,
      io: memoryFs({
        [`${root}/.git`]: "gitdir: /repo/.git/worktrees/10-28-leaf\n",
        "/repo/.git/worktrees/10-28-leaf/commondir": "../..\n",
        "/repo/.git/worktrees/10-28-leaf/HEAD":
          "ref: refs/heads/phronia/10-28-leaf\n",
      }),
      exec: throwingExec().exec,
      now: NOW,
    });
    expect(facts.mainRoot).toBe("/repo");
    expect(facts.toplevel).toBe(root);
    expect(facts.isLinkedWorktree).toBe(true);
    expect(facts.branch).toBe("phronia/10-28-leaf");
    expect(facts.factsReliable).toBe(true);
  });

  it("treats a detached HEAD as an empty branch without git", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(
        standardFiles({
          "/repo/.git/HEAD": "0123456789abcdef0123456789abcdef01234567\n",
        }),
      ),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.branch).toBe("");
  });

  it("does not run status when no claim exists", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles()),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.mainDirty).toBeNull();
    expect(facts.factsReliable).toBe(true);
  });

  it("degrades corrupt claim JSON to null with a diagnostic", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles({ [CLAIM_PATH]: "{" })),
      exec: recorder.exec,
      now: NOW,
    });
    // A corrupt claim is null, so status is not read either.
    expect(recorder.calls).toEqual([]);
    expect(facts.claim).toBeNull();
    expect(facts.factsReliable).toBe(false);
    expect(codes(facts)).toContain("state.runtime.claim_invalid");
  });

  it("treats an unknown schemaVersion as unreliable", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(
        standardFiles({ [CLAIM_PATH]: claimFile({ schemaVersion: 99 }) }),
      ),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.claim).toBeNull();
    expect(facts.factsReliable).toBe(false);
    expect(codes(facts)).toContain("state.runtime.schema_unsupported");
  });
});

describe("readRuntimeFacts claim-gated status", () => {
  it("runs status when a claim exists and records dirtiness", () => {
    const recorder = recordingExec((key) => {
      if (key === "status --porcelain") {
        return gitResult(" M src/a.ts\n");
      }
      throw new Error(`unexpected git call: ${key}`);
    });
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles({ [CLAIM_PATH]: claimFile() })),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual(["status --porcelain"]);
    expect(facts.mainDirty).toBe(true);
    expect(facts.factsReliable).toBe(true);
  });

  it("skips status when includeMainDirty is false even with a claim", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles({ [CLAIM_PATH]: claimFile() })),
      exec: recorder.exec,
      now: NOW,
      includeMainDirty: false,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.mainDirty).toBeNull();
    expect(facts.factsReliable).toBe(true);
  });

  it("computes TTL staleness from now", () => {
    const recorder = recordingExec(() => gitResult(""));
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles({ [CLAIM_PATH]: claimFile() })),
      exec: recorder.exec,
      now: NOW,
    });
    expect(facts.claim?.stale).toBe(true);
    expect(facts.claim?.taskRef).toBe(".phronia/tasks/10-28-leaf");
    expect(facts.mainDirty).toBe(false);
  });

  it("sets factsReliable=false when a claim exists and status fails", () => {
    const recorder = recordingExec((key) => {
      if (key === "status --porcelain") {
        return gitResult("", 1);
      }
      throw new Error(`unexpected git call: ${key}`);
    });
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(standardFiles({ [CLAIM_PATH]: claimFile() })),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual(["status --porcelain"]);
    expect(facts.mainDirty).toBeNull();
    expect(facts.factsReliable).toBe(false);
    expect(codes(facts)).toContain("state.runtime.git_status_failed");
  });
});

describe("readRuntimeFacts registries", () => {
  it("drops a registered worktree whose path no longer exists", () => {
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(
        standardFiles({
          "/repo/.git/phronia/worktrees.json": JSON.stringify({
            schemaVersion: 1,
            worktrees: [
              {
                taskRef: ".phronia/tasks/10-28-leaf",
                path: "/repo/.phronia/worktrees/10-28-leaf",
                branch: "phronia/10-28-leaf",
                kind: "phronia",
              },
            ],
          }),
        }),
      ),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.worktrees).toEqual([]);
    expect(facts.factsReliable).toBe(true);
    expect(codes(facts)).toContain("state.runtime.worktree_missing");
  });

  it("keeps a live worktree and normalizes provisional entries", () => {
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(
        standardFiles({
          "/repo/.phronia/worktrees/10-28-leaf/.keep": "",
          "/repo/.phronia/worktrees/provisional/.keep": "",
          "/repo/.git/phronia/worktrees.json": JSON.stringify({
            schemaVersion: 1,
            worktrees: [
              {
                taskRef: ".phronia/tasks/10-28-leaf",
                path: "/repo/.phronia/worktrees/10-28-leaf",
                branch: "phronia/10-28-leaf",
                kind: "phronia",
              },
              {
                taskRef: "",
                path: "/repo/.phronia/worktrees/provisional",
                branch: "",
                provisional: true,
              },
            ],
          }),
        }),
      ),
      exec: throwingExec().exec,
      now: NOW,
    });
    expect(facts.worktrees).toHaveLength(2);
    expect(facts.worktrees[0].taskRef).toBe(".phronia/tasks/10-28-leaf");
    expect(facts.worktrees[1].taskRef).toBeNull();
    expect(facts.worktrees[1].provisional).toBe(true);
  });

  it("reads multiple leases and flags stale ones", () => {
    const paths = sharedRuntimePaths("/repo/.git");
    const stale = ".phronia/tasks/10-28-old";
    const fresh = ".phronia/tasks/10-28-new";
    const recorder = throwingExec();
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs(
        standardFiles({
          [taskLeasePath(paths, stale)]: leaseFile(
            stale,
            "session-old",
            "2026-10-28T00:00:00.000Z",
          ),
          [taskLeasePath(paths, fresh)]: leaseFile(
            fresh,
            "session-new",
            "2026-10-28T00:59:30.000Z",
          ),
        }),
      ),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([]);
    expect(facts.leases).toHaveLength(2);
    const oldLease = facts.leases.find((lease) => lease.taskRef === stale);
    const newLease = facts.leases.find((lease) => lease.taskRef === fresh);
    expect(oldLease?.stale).toBe(true);
    expect(newLease?.stale).toBe(false);
    expect(oldLease?.path).toBe(taskLeasePath(paths, stale));
  });
});

describe("readRuntimeFacts git fallback", () => {
  it("uses exactly one combined rev-parse for a subdirectory/non-standard root", () => {
    const recorder = recordingExec((key) => {
      if (key === "rev-parse --git-common-dir --show-toplevel") {
        return gitResult("/repo/.git\n/repo\n");
      }
      throw new Error(`unexpected git call: ${key}`);
    });
    const facts = readRuntimeFacts({
      root: "/repo/packages/app",
      io: memoryFs({ "/repo/packages/app/.keep": "" }),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([
      "rev-parse --git-common-dir --show-toplevel",
    ]);
    expect(facts.mainRoot).toBe("/repo");
    expect(facts.toplevel).toBe("/repo");
    expect(facts.isLinkedWorktree).toBe(false);
    expect(facts.branch).toBe("");
    expect(facts.factsReliable).toBe(true);
    expect(codes(facts)).toContain("state.runtime.git_fallback");
  });

  it("falls back when a .git file points at an unreadable gitdir", () => {
    const recorder = recordingExec((key) => {
      if (key === "rev-parse --git-common-dir --show-toplevel") {
        return gitResult("/repo/.git\n/repo\n");
      }
      throw new Error(`unexpected git call: ${key}`);
    });
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs({
        "/repo/.git": "gitdir: /missing/.git/worktrees/x\n",
      }),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([
      "rev-parse --git-common-dir --show-toplevel",
    ]);
    expect(facts.factsReliable).toBe(true);
  });

  it("never throws outside a git repository", () => {
    const recorder = recordingExec(() => gitResult("", 128));
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs({}),
      exec: recorder.exec,
      now: NOW,
    });
    expect(recorder.calls).toEqual([
      "rev-parse --git-common-dir --show-toplevel",
    ]);
    expect(facts.mainRoot).toBeNull();
    expect(facts.toplevel).toBeNull();
    expect(facts.isLinkedWorktree).toBe(false);
    expect(facts.branch).toBe("");
    expect(facts.mainDirty).toBeNull();
    expect(facts.claim).toBeNull();
    expect(facts.factsReliable).toBe(false);
    expect(codes(facts)).toContain("state.runtime.git_unavailable");
  });

  it("reports an incomplete combined rev-parse as unreliable", () => {
    const facts = readRuntimeFacts({
      root: "/repo",
      io: memoryFs({}),
      exec: recordingExec(() => gitResult("/repo/.git\n")).exec,
      now: NOW,
    });
    expect(facts.factsReliable).toBe(false);
    expect(codes(facts)).toContain("state.runtime.git_layout_invalid");
  });
});

describe("gitCommonDir", () => {
  function singleExec(overrides: Readonly<Record<string, GitResult>> = {}): GitExec {
    return (args) =>
      overrides[args.join(" ")] ?? gitResult("", 128);
  }

  it("resolves a relative git-common-dir against the root", () => {
    expect(
      gitCommonDir("/repo", singleExec({
        "rev-parse --git-common-dir": gitResult(".git\n"),
      })),
    ).toBe("/repo/.git");
  });

  it("returns null outside a git repository", () => {
    expect(
      gitCommonDir("/repo", singleExec({
        "rev-parse --git-common-dir": gitResult("", 128),
      })),
    ).toBeNull();
  });

  it("returns null for a timeout or empty output", () => {
    expect(
      gitCommonDir("/repo", singleExec({
        "rev-parse --git-common-dir": { status: null, stdout: "", stderr: "" },
      })),
    ).toBeNull();
    expect(
      gitCommonDir("/repo", singleExec({
        "rev-parse --git-common-dir": gitResult("   \n"),
      })),
    ).toBeNull();
  });
});
