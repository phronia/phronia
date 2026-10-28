import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleContext } from "../../src/context/index.js";
import type { ContextRequest } from "../../src/context/types.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const HOOK = path.join(REPO_ROOT, ".claude/hooks/inject-workflow-state.py");
const HOOK_CODEX = path.join(REPO_ROOT, ".codex/hooks/inject-workflow-state.py");
const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

const WORKFLOW = [
  "# Workflow",
  "",
  "[workflow-state:no_task]",
  "No task yet. Create one when the user describes real work.",
  "[/workflow-state:no_task]",
  "",
  "[workflow-state:planning]",
  "Planning body.",
  "[/workflow-state:planning]",
  "",
  "[workflow-state:planning-inline]",
  "Inline planning body.",
  "[/workflow-state:planning-inline]",
  "",
  "[workflow-state:in_progress]",
  "Execute body.",
  "[/workflow-state:in_progress]",
  "",
].join("\n");

describe.skipIf(!pythonAvailable)("user-prompt parity", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-user-prompt-"));
    fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/workflow.md"), WORKFLOW);
    fs.writeFileSync(path.join(root, ".phronia/config.yaml"), "session_auto_commit: false\n");
    fs.symlinkSync(
      path.join(REPO_ROOT, "packages/cli/src/templates/workflow/scripts"),
      path.join(root, ".phronia/scripts"),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("matches no_task", () => {
    expect(runCase(root, "claude", { prompt: "hello" })).toBe(
      "<workflow-state>\nStatus: no_task\nNo task yet. Create one when the user describes real work.\n</workflow-state>",
    );
  });

  it("matches a planning task", () => {
    writeTask(root, "planning");
    expect(runCase(root, "claude", { prompt: "continue" })).toContain(
      "Planning body.",
    );
  });

  it("matches an in-progress task", () => {
    writeTask(root, "in_progress");
    expect(runCase(root, "claude", { prompt: "continue" })).toContain(
      "Execute body.",
    );
  });

  it("matches a stale pointer", () => {
    writeSession(root, ".phronia/tasks/99-99-missing");
    expect(runCase(root, "claude", { prompt: "continue" })).toContain(
      "(stale_session)",
    );
  });

  it("matches a task_error for a missing record", () => {
    fs.mkdirSync(path.join(root, ".phronia/tasks/01-01-broken"), { recursive: true });
    writeSession(root, ".phronia/tasks/01-01-broken");
    expect(runCase(root, "claude", { prompt: "continue" })).toContain(
      "(task_error)",
    );
  });

  it("emits nothing for the skip keyword", () => {
    expect(runCase(root, "claude", { prompt: "no-trellis please" })).toBe("");
  });

  it("matches Codex inline mode", () => {
    writeTask(root, "planning");
    fs.writeFileSync(
      path.join(root, ".phronia/config.yaml"),
      "codex:\n  dispatch_mode: inline\n",
    );
    const text = runCase(root, "codex", { prompt: "continue" });
    expect(text).toContain("<codex-mode>inline:");
    expect(text).toContain("Inline planning body.");
  });

  it("matches Kiro plain text", () => {
    const text = runCase(root, "kiro", { prompt: "hello" });
    expect(text.startsWith("<workflow-state>")).toBe(true);
  });
});

function runCase(
  root: string,
  platform: "claude" | "codex" | "kiro",
  payload: Record<string, unknown>,
): string {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  if (platform === "codex") env.CODEX_PROJECT_DIR = root;
  else if (platform === "kiro") env.KIRO_PROJECT_DIR = root;
  else env.CLAUDE_PROJECT_DIR = root;

  const hook = platform === "codex" ? HOOK_CODEX : HOOK;
  const python = spawnSync("python3", [hook], {
    cwd: root,
    input: JSON.stringify({
      cwd: root,
      session_id: "abc",
      ...payload,
    }),
    env,
    encoding: "utf8",
  });
  expect(python.status, python.stderr).toBe(0);

  let expected: string;
  if (platform === "kiro" || python.stdout.trim().length === 0) {
    expected = python.stdout;
  } else {
    const parsed = JSON.parse(python.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expected = parsed.hookSpecificOutput.additionalContext;
  }

  const request: ContextRequest = {
    schemaVersion: 1,
    event: "user-prompt",
    platform: { id: platform === "claude" ? "claude-code" : platform },
    projectRoot: root,
    input: { session_id: "abc", ...payload },
    env,
  };
  const response = handleContext(request);
  // S1 appends a separate `runtime-state` block. The standalone Python scripts
  // are retained only as a legacy-migration guard; every platform hook config
  // calls `phronia-hook.py` → TS core. Parity here therefore covers the
  // workflow breadcrumb body only, not the new facts block.
  const workflow = response.blocks.find((block) => block.id === "workflow-state");
  const actual = workflow?.text ?? "";
  // The legacy Kiro shim writes a trailing newline; the other envelopes do not.
  expect(platform === "kiro" && actual.length > 0 ? `${actual}\n` : actual).toBe(
    expected,
  );
  return actual;
}

function writeTask(root: string, status: string): void {
  const dir = path.join(root, ".phronia/tasks/01-01-one");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({ id: "one", title: "One", status }),
  );
  writeSession(root, ".phronia/tasks/01-01-one");
}

function writeSession(root: string, taskRef: string): void {
  for (const key of ["claude_abc", "codex_abc", "kiro_abc"]) {
    fs.writeFileSync(
      path.join(root, ".phronia/.runtime/sessions", `${key}.json`),
      JSON.stringify({ platform: key.split("_")[0], current_task: taskRef }),
    );
  }
}
