import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPreShell,
  extractTaskSubcommands,
  splitShell,
} from "../../src/context/pre-shell.js";
import { renderContext } from "../../src/context/index.js";
import type { ContextRequest } from "../../src/context/types.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const HOOK_TEMPLATE = path.join(
  REPO_ROOT,
  "packages/cli/src/templates/shared-hooks/inject-shell-session-context.py",
);
const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

describe("shell command parsing", () => {
  it("splits quotes and escapes", () => {
    expect(splitShell(`python3 task.py start ".phronia/tasks/a b"`)).toEqual([
      "python3",
      "task.py",
      "start",
      ".phronia/tasks/a b",
    ]);
    expect(splitShell(`echo 'unbalanced`)).toBeNull();
  });

  it("extracts session subcommands", () => {
    expect(
      extractTaskSubcommands("python3 ./.phronia/scripts/task.py start .phronia/tasks/01-01-a"),
    ).toEqual([{ name: "start", task_ref: ".phronia/tasks/01-01-a" }]);
    expect(extractTaskSubcommands("python3 task.py current")).toEqual([
      { name: "current" },
    ]);
    expect(extractTaskSubcommands("ls -la")).toEqual([]);
  });
});

describe("pre-shell ticket", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-shell-"));
    fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns a ticket effect for a task.py start command", () => {
    const response = buildPreShell(
      request(root, {
        session_id: "abc",
        tool_name: "Bash",
        tool_input: {
          command: "python3 ./.phronia/scripts/task.py start .phronia/tasks/01-01-a",
        },
      }),
    );
    expect(response.envelope).toBe("none");
    expect(response.effects).toHaveLength(1);
    const effect = response.effects[0];
    expect(effect?.type).toBe("shell-ticket");
    if (effect?.type !== "shell-ticket") return;
    const ticket = JSON.parse(effect.content) as {
      context_key: string;
      command: string;
      subcommands: unknown;
      cwd: string;
      expires_at_epoch: number;
      created_at_epoch: number;
    };
    expect(ticket.context_key).toBe("claude_abc");
    expect(ticket.command).toContain("task.py start");
    expect(ticket.subcommands).toEqual([
      { name: "start", task_ref: ".phronia/tasks/01-01-a" },
    ]);
    expect(ticket.cwd).toBe(fs.realpathSync(root));
    expect(ticket.expires_at_epoch - ticket.created_at_epoch).toBe(30);
  });

  it("answers permission allow for a shell-execution payload", () => {
    const response = buildPreShell(
      request(root, {
        session_id: "abc",
        command: "python3 task.py current",
      }),
    );
    expect(response.envelope).toBe("shell-allow");
    expect(renderContext(response)).toBe('{"permission":"allow"}');
  });

  it("returns no effect without a top-level identity", () => {
    const response = buildPreShell(
      request(root, {
        tool_input: { command: "python3 task.py current" },
      }),
    );
    expect(response.effects).toEqual([]);
    expect(response.diagnostics.map((item) => item.code)).toContain(
      "context.pre_shell.no_identity",
    );
  });
});

describe.skipIf(!pythonAvailable)("pre-shell parity", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-shell-parity-"));
    fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), { recursive: true });
    fs.mkdirSync(path.join(root, ".phronia/.runtime/shell-tickets"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/config.yaml"), "session_auto_commit: false\n");
    fs.symlinkSync(
      path.join(REPO_ROOT, "packages/cli/src/templates/workflow/scripts"),
      path.join(root, ".phronia/scripts"),
    );
    fs.mkdirSync(path.join(root, ".claude/hooks"), { recursive: true });
    fs.copyFileSync(HOOK_TEMPLATE, path.join(root, ".claude/hooks/inject-shell-session-context.py"));
    fs.writeFileSync(
      path.join(root, ".phronia/.runtime/sessions/claude_abc.json"),
      JSON.stringify({ platform: "claude", current_task: ".phronia/tasks/01-01-a" }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes the same ticket fields as the Python hook", () => {
    const payload = {
      cwd: root,
      session_id: "abc",
      tool_name: "Bash",
      tool_input: { command: "python3 task.py start .phronia/tasks/01-01-a" },
    };
    const python = spawnSync(
    "python3",
    [path.join(root, ".claude/hooks/inject-shell-session-context.py")],
    {
      cwd: root,
      input: JSON.stringify(payload),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLAUDE_PROJECT_DIR: root,
      },
        encoding: "utf8",
      },
    );
    expect(python.status, python.stderr).toBe(0);

    const files = fs
      .readdirSync(path.join(root, ".phronia/.runtime/shell-tickets"))
      .filter((entry) => entry.endsWith(".json"));
    expect(files).toHaveLength(1);
    const pythonTicket = JSON.parse(
      fs.readFileSync(
        path.join(root, ".phronia/.runtime/shell-tickets", files[0] ?? ""),
        "utf8",
      ),
    ) as Record<string, unknown>;

    const response = buildPreShell(request(root, payload));
    const effect = response.effects[0];
    expect(effect?.type).toBe("shell-ticket");
    if (effect?.type !== "shell-ticket") return;
    const coreTicket = JSON.parse(effect.content) as Record<string, unknown>;

    for (const key of [
      "platform",
      "context_key",
      "session_id",
      "cwd",
      "command",
      "subcommands",
    ]) {
      expect(coreTicket[key]).toEqual(pythonTicket[key]);
    }
    expect(
      Number(coreTicket.expires_at_epoch) - Number(coreTicket.created_at_epoch),
    ).toBe(
      Number(pythonTicket.expires_at_epoch) - Number(pythonTicket.created_at_epoch),
    );
  });
});

function request(root: string, input: unknown): ContextRequest {
  return {
    schemaVersion: 1,
    event: "pre-shell",
    platform: { id: "claude-code" },
    projectRoot: root,
    input,
    env: { CLAUDE_PROJECT_DIR: root },
    options: { now: 1000 },
  };
}
