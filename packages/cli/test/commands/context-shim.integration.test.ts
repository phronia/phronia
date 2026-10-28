import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/dist/cli/index.js");
const SHIM = path.join(
  REPO_ROOT,
  "packages/cli/src/templates/shared-hooks/phronia-hook.py",
);
describe("phronia-hook shim", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-shim-"));
    fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), { recursive: true });
    fs.mkdirSync(path.join(root, ".claude/hooks"), { recursive: true });
    fs.copyFileSync(SHIM, path.join(root, ".claude/hooks/phronia-hook.py"));
    fs.writeFileSync(path.join(root, ".phronia/config.yaml"), "session_auto_commit: false\n");
    fs.writeFileSync(
      path.join(root, ".phronia/workflow.md"),
      "# Workflow\n\n## Phase Index\n\nPhase 1: Plan\n\n## Phase 1: Plan\n\nDetail\n",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delegates session-start to the core and applies the env effect", () => {
    const envFile = path.join(root, ".claude/env.sh");
    const result = spawnSync(
      "python3",
      [
        path.join(root, ".claude/hooks/phronia-hook.py"),
        "--event",
        "session-start",
        "--platform",
        "claude",
      ],
      {
        cwd: root,
        input: JSON.stringify({ cwd: root, session_id: "abc" }),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLAUDE_PROJECT_DIR: root,
          CLAUDE_ENV_FILE: envFile,
          PHRONIA_CLI_PATH: CLI_ENTRY,
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Phronia compact SessionStart context");
    expect(fs.readFileSync(envFile, "utf8")).toContain(
      "export PHRONIA_CONTEXT_ID='claude_abc'",
    );
  });

  it("applies a sub-agent prompt mutation", () => {
    fs.mkdirSync(path.join(root, ".phronia/tasks/01-01-one"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".phronia/tasks/01-01-one/task.json"),
      JSON.stringify({ id: "one", title: "One", status: "in_progress" }),
    );
    fs.writeFileSync(path.join(root, ".phronia/tasks/01-01-one/implement.jsonl"), "");
    fs.writeFileSync(
      path.join(root, ".phronia/.runtime/sessions/claude_abc.json"),
      JSON.stringify({ current_task: ".phronia/tasks/01-01-one" }),
    );

    const result = spawnSync(
      "python3",
      [
        path.join(root, ".claude/hooks/phronia-hook.py"),
        "--event",
        "subagent-spawn",
        "--platform",
        "claude",
      ],
      {
        cwd: root,
        input: JSON.stringify({
          cwd: root,
          session_id: "abc",
          tool_name: "Task",
          tool_input: { subagent_type: "phronia-implement", prompt: "do it" },
        }),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLAUDE_PROJECT_DIR: root,
          PHRONIA_CLI_PATH: CLI_ENTRY,
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      hookSpecificOutput: { updatedInput: { prompt: string } };
    };
    expect(payload.hookSpecificOutput.updatedInput.prompt).toContain(
      "<!-- phronia-hook-injected -->",
    );
    expect(payload.hookSpecificOutput.updatedInput.prompt).toContain("do it");
  });
});

const PARENT = ".phronia/tasks/10-28-parent";
const CHILD = ".phronia/tasks/10-28-child";
const OTHER = ".phronia/tasks/10-28-other";
const LEAF = ".phronia/tasks/10-28-leaf";

function seedGit(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
}

function seedTask(
  root: string,
  ref: string,
  task: Record<string, unknown>,
): void {
  const dir = path.join(root, ref);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id: path.basename(ref),
      title: path.basename(ref),
      status: "planning",
      ...task,
    }),
  );
  fs.writeFileSync(path.join(dir, "implement.jsonl"), "");
  fs.writeFileSync(path.join(dir, "check.jsonl"), "");
}

function seedRepo(
  root: string,
  tasks: Record<string, Record<string, unknown>>,
  active: string,
  sessionKey = "claude_abc",
): void {
  seedGit(root);
  fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, ".claude/hooks"), { recursive: true });
  fs.copyFileSync(SHIM, path.join(root, ".claude/hooks/phronia-hook.py"));
  fs.writeFileSync(
    path.join(root, ".phronia/config.yaml"),
    "session_auto_commit: false\n",
  );
  for (const [ref, task] of Object.entries(tasks)) {
    seedTask(root, ref, task);
  }
  fs.writeFileSync(
    path.join(root, ".phronia/.runtime/sessions", `${sessionKey}.json`),
    JSON.stringify({ current_task: active }),
  );
}

function seedWorktree(
  root: string,
  worktreePath: string,
  taskRef: string,
): void {
  fs.mkdirSync(worktreePath, { recursive: true });
  const registry = path.join(root, ".git/phronia/worktrees.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(
    registry,
    JSON.stringify({
      schemaVersion: 1,
      worktrees: [
        {
          taskRef,
          path: worktreePath,
          branch: `phronia/${path.basename(worktreePath)}`,
          kind: "phronia",
          provisional: false,
        },
      ],
    }),
  );
}

function shimEnv(root: string): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PHRONIA_CLI_PATH: CLI_ENTRY,
    CLAUDE_PROJECT_DIR: root,
    CODEX_PROJECT_DIR: root,
    PHRONIA_HOOKS: "1",
  };
}

function runPlan(
  root: string,
  platform: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      CLI_ENTRY,
      "context",
      "--event",
      "subagent-spawn",
      "--platform",
      platform,
      "--project-root",
      root,
      "--input",
      "-",
      "--json",
    ],
    {
      cwd: root,
      input: JSON.stringify(payload),
      env: shimEnv(root),
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runShim(
  root: string,
  platform: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = spawnSync(
    "python3",
    [
      path.join(root, ".claude/hooks/phronia-hook.py"),
      "--event",
      "subagent-spawn",
      "--platform",
      platform,
    ],
    {
      cwd: root,
      input: JSON.stringify(payload),
      env: shimEnv(root),
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("dispatch admission", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-admission-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("denies a parent task before materializing context", () => {
    seedRepo(
      root,
      {
        [PARENT]: { status: "in_progress", children: [CHILD] },
        [CHILD]: { status: "planning", parent: PARENT },
      },
      PARENT,
    );
    const response = runPlan(root, "claude-code", {
      session_id: "abc",
      subagent_type: "phronia-implement",
      prompt: "do it",
    }) as {
      mutations: { op: string; code: string; next: string[] }[];
      blocks: unknown[];
      degraded: boolean;
    };
    expect(response.blocks).toEqual([]);
    expect(response.degraded).toBe(false);
    expect(response.mutations[0]).toMatchObject({
      op: "deny",
      code: "DISPATCH_PARENT_TASK",
    });
    expect(response.mutations[0]?.next.length).toBeGreaterThan(0);
  });

  it("denies a task that has not been started", () => {
    seedRepo(root, { [LEAF]: { status: "planning" } }, LEAF);
    const response = runPlan(root, "claude-code", {
      session_id: "abc",
      subagent_type: "phronia-implement",
      prompt: "do it",
    }) as { mutations: { op: string; code: string }[] };
    expect(response.mutations[0]).toMatchObject({
      op: "deny",
      code: "DISPATCH_TASK_NOT_IN_PROGRESS",
    });
  });

  it("denies a dispatch from the main checkout when the task has a worktree", () => {
    seedRepo(root, { [LEAF]: { status: "in_progress" } }, LEAF);
    seedWorktree(root, path.join(root, ".phronia/worktrees/leaf"), LEAF);
    const response = runPlan(root, "claude-code", {
      session_id: "abc",
      subagent_type: "phronia-implement",
      prompt: "do it",
    }) as { mutations: { op: string; code: string }[] };
    expect(response.mutations[0]).toMatchObject({
      op: "deny",
      code: "DISPATCH_WRONG_CHECKOUT",
    });
  });

  it("denies a requested task outside the active task's subtree", () => {
    seedRepo(
      root,
      {
        [PARENT]: { status: "in_progress", children: [CHILD] },
        [CHILD]: { status: "in_progress", parent: PARENT },
        [OTHER]: { status: "in_progress" },
      },
      PARENT,
    );
    const response = runPlan(root, "claude-code", {
      session_id: "abc",
      task_ref: OTHER,
      subagent_type: "phronia-implement",
      prompt: "do it",
    }) as { mutations: { op: string; code: string }[] };
    expect(response.mutations[0]).toMatchObject({
      op: "deny",
      code: "DISPATCH_TASK_NOT_CHILD",
    });
  });

  it("allows an unclaimed task with a workspace guard in the prompt", () => {
    seedRepo(root, { [LEAF]: { status: "in_progress" } }, LEAF);
    const response = runPlan(root, "claude-code", {
      session_id: "abc",
      subagent_type: "phronia-implement",
      prompt: "do it",
    }) as { mutations: { op: string; value?: string }[] };
    expect(response.mutations[0]?.op).toBe("set-prompt");
    const prompt = response.mutations[0]?.value ?? "";
    expect(prompt.startsWith('<workspace-guard code="DISPATCH_NO_CLAIM"')).toBe(
      true,
    );
    expect(prompt).toContain("claim: none");
    expect(prompt).toContain("phronia task workspace ensure .phronia/tasks/10-28-leaf");
    expect(prompt).toContain("<!-- phronia-hook-injected -->");
  });

  it("lets research through without a guard", () => {
    seedRepo(root, { [LEAF]: { status: "in_progress" } }, LEAF);
    const response = runPlan(root, "claude-code", {
      session_id: "abc",
      subagent_type: "phronia-research",
      prompt: "investigate",
    }) as { mutations: { op: string; value?: string }[] };
    expect(response.mutations[0]?.op).toBe("set-prompt");
    expect(response.mutations[0]?.value).not.toContain("<workspace-guard");
  });

  it("renders a ZCode deny without updatedInput", () => {
    seedRepo(
      root,
      {
        [PARENT]: { status: "in_progress", children: [CHILD] },
        [CHILD]: { status: "planning", parent: PARENT },
      },
      PARENT,
    );
    const output = runShim(root, "zcode", {
      cwd: root,
      session_id: "abc",
      tool_name: "Task",
      tool_input: { subagent_type: "phronia-implement", prompt: "do it" },
    }) as {
      hookSpecificOutput: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        updatedInput?: unknown;
      };
      updatedInput?: unknown;
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      "DISPATCH_PARENT_TASK",
    );
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      "Do not retry; report this exactly.",
    );
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(output.updatedInput).toBeUndefined();
  });

  it("renders a Codex SubagentStart guard instead of a deny", () => {
    seedRepo(
      root,
      {
        [PARENT]: { status: "in_progress", children: [CHILD] },
        [CHILD]: { status: "planning", parent: PARENT },
      },
      PARENT,
      "codex_abc",
    );
    const output = runShim(root, "codex", {
      cwd: root,
      session_id: "abc",
      agent_type: "phronia-implement",
      prompt: "do it",
    }) as {
      hookSpecificOutput: {
        hookEventName?: string;
        additionalContext?: string;
      };
      permissionDecision?: string;
    };
    expect(output.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    const context = output.hookSpecificOutput.additionalContext ?? "";
    expect(context.startsWith("<workspace-guard")).toBe(true);
    expect(context.split("\n")[1]).toMatch(/^STOP:/);
    expect(context).toContain("DISPATCH_PARENT_TASK");
  });

  it("throws from the OpenCode v1 plugin on a denied dispatch", async () => {
    seedRepo(root, { [PARENT]: { status: "in_progress", children: [CHILD] }, [CHILD]: { status: "planning", parent: PARENT } }, PARENT, "opencode_abc");
    const previous = process.env.PHRONIA_CLI_PATH;
    process.env.PHRONIA_CLI_PATH = CLI_ENTRY;
    try {
      const module = await import(
        "../../src/templates/opencode/adapters/v1/plugins/inject-subagent-context.js"
      );
      const plugin = await module.default({ directory: root, env: process.env });
      const hook = plugin["tool.execute.before"];
      await expect(
        hook(
          { session_id: "abc", tool: "task" },
          { args: { subagent_type: "phronia-implement", prompt: "do it" } },
        ),
      ).rejects.toThrow(/\[DISPATCH_PARENT_TASK\]/);
    } finally {
      if (previous === undefined) delete process.env.PHRONIA_CLI_PATH;
      else process.env.PHRONIA_CLI_PATH = previous;
    }
  });

  it("throws from the OpenCode v2 plugin on a denied dispatch", async () => {
    seedRepo(
      root,
      {
        [PARENT]: { status: "in_progress", children: [CHILD] },
        [CHILD]: { status: "planning", parent: PARENT },
      },
      PARENT,
      "opencode_abc",
    );
    const previous = process.env.PHRONIA_CLI_PATH;
    process.env.PHRONIA_CLI_PATH = CLI_ENTRY;
    try {
      const module = await import(
        "../../src/templates/opencode/adapters/v2/plugin.js"
      );
      let handler: ((event: unknown) => Promise<void>) | null = null;
      await module.default.setup({
        location: { directory: root },
        tool: {
          hook: async (_name: string, fn: (event: unknown) => Promise<void>) => {
            handler = fn;
            return { dispose: () => undefined };
          },
        },
      });
      expect(handler).not.toBeNull();
      await expect(
        handler?.({
          tool: "subagent",
          sessionID: "abc",
          input: { agent: "phronia-implement", prompt: "do it" },
        }),
      ).rejects.toThrow(/\[DISPATCH_PARENT_TASK\]/);
    } finally {
      if (previous === undefined) delete process.env.PHRONIA_CLI_PATH;
      else process.env.PHRONIA_CLI_PATH = previous;
    }
  });
});
