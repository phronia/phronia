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
