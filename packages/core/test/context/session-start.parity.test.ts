import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleContext, renderContext } from "../../src/context/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const SCRIPTS_DIR = path.join(REPO_ROOT, "packages/cli/src/templates/workflow/scripts");
const HOOK = path.join(REPO_ROOT, ".claude/hooks/session-start.py");
const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

describe.skipIf(!pythonAvailable)("session-start parity", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-context-"));
    seed(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("matches the Python session-start payload block for block", () => {
    const python = spawnSync("python3", [HOOK], {
      cwd: root,
      input: JSON.stringify({ cwd: root, session_id: "abc" }),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLAUDE_PROJECT_DIR: root,
        PHRONIA_HOOKS: "1",
      },
      encoding: "utf8",
    });
    expect(python.status, python.stderr).toBe(0);
    const payload = JSON.parse(python.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const expected = payload.hookSpecificOutput.additionalContext.trimEnd();

    const response = handleContext({
      schemaVersion: 1,
      event: "session-start",
      platform: { id: "claude-code" },
      projectRoot: root,
      input: { session_id: "abc" },
      env: { CLAUDE_PROJECT_DIR: root },
    });
    const actual = renderContext(response).length > 0
      ? response.blocks.map((block) => block.text).join("\n\n")
      : "";

    expect(actual).toBe(expected);
  });
});

function seed(root: string): void {
  fs.mkdirSync(path.join(root, ".phronia/spec/guides"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/tasks/01-01-one"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/workspace/alice"), { recursive: true });
  fs.symlinkSync(SCRIPTS_DIR, path.join(root, ".phronia/scripts"));

  fs.writeFileSync(path.join(root, ".phronia/config.yaml"), "session_auto_commit: false\n");
  fs.writeFileSync(
    path.join(root, ".phronia/workflow.md"),
    [
      "# Workflow",
      "",
      "## Phase Index",
      "",
      "Phase 1: Plan",
      "",
      "## Phase 1: Plan",
      "",
      "Detail",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, ".phronia/.version"), "0.6.17");
  fs.writeFileSync(path.join(root, ".phronia/.developer"), "name=alice\n");
  fs.writeFileSync(path.join(root, ".phronia/workspace/alice/journal-1.md"), "a\nb\n");
  fs.writeFileSync(path.join(root, ".phronia/spec/guides/index.md"), "# guides");
  fs.writeFileSync(
    path.join(root, ".phronia/tasks/01-01-one/task.json"),
    JSON.stringify({
      id: "one",
      title: "One",
      status: "planning",
      package: null,
    }),
  );
  fs.writeFileSync(path.join(root, ".phronia/tasks/01-01-one/prd.md"), "# PRD");
  fs.writeFileSync(path.join(root, ".phronia/tasks/01-01-one/implement.jsonl"), "");
  fs.writeFileSync(path.join(root, ".phronia/tasks/01-01-one/check.jsonl"), "");
  fs.writeFileSync(
    path.join(root, ".phronia/.runtime/sessions/claude_abc.json"),
    JSON.stringify({ platform: "claude", current_task: ".phronia/tasks/01-01-one" }),
  );
}
