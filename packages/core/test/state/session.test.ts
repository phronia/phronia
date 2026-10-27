import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveContextKey,
  contextKey,
  sanitizeKey,
} from "../../src/state/session/key.js";
import { resolveActiveTask } from "../../src/state/session/active-task.js";
import { lookupShellTicketContextKey } from "../../src/state/session/tickets.js";
import { resolveTaskRef } from "../../src/state/tasks/refs.js";
import { nodeFs } from "../../src/state/fs.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const SCRIPTS_DIR = path.join(
  REPO_ROOT,
  "packages/cli/src/templates/workflow/scripts",
);
const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

describe("context key resolution", () => {
  it("prefers the explicit env override", () => {
    const result = resolveContextKey(
      { session_id: "ignored" },
      { env: { PHRONIA_CONTEXT_ID: "override" } },
    );
    expect(result).toMatchObject({ key: "override", source: "env" });
  });

  it("uses payload session, then conversation, then transcript", () => {
    expect(
      resolveContextKey({ session_id: "abc" }, { platform: "claude", env: {} }),
    ).toMatchObject({ key: "claude_abc", source: "payload-session" });
    expect(
      resolveContextKey({ conversation_id: "abc" }, { platform: "cursor", env: {} }),
    ).toMatchObject({ key: "cursor_abc", source: "payload-conversation" });
    const transcript = resolveContextKey(
      { transcript_path: "/tmp/x.jsonl" },
      { platform: "cursor", env: {} },
    );
    expect(transcript.source).toBe("payload-transcript");
    expect(transcript.key).toMatch(/^cursor_transcript_[0-9a-f]{24}$/);
  });

  it("finds nested payload fields", () => {
    const result = resolveContextKey(
      { hook_input: { input: { sessionId: "nested" } } },
      { platform: "codex", env: {} },
    );
    expect(result.key).toBe("codex_nested");
  });

  it("applies platform aliases to the key", () => {
    expect(contextKey("zcode", "session", "abc")).toBe("claude_abc");
    expect(contextKey("factory", "session", "abc")).toBe("droid_abc");
  });

  it("reads platform environment variables, DSH first", () => {
    const env = {
      DSH_SESSION_ID: "dsh",
      CODEX_THREAD_ID: "codex",
      CLAUDE_CODE_SESSION_ID: "claude",
    };
    expect(resolveContextKey(null, { env }).key).toBe("dsh_dsh");
    expect(
      resolveContextKey(null, { platform: "codex", env }).key,
    ).toBe("codex_codex");
    // ZCode reuses Claude's env name but canonicalizes to claude.
    expect(
      resolveContextKey(null, { platform: "zcode", env }).key,
    ).toBe("claude_claude");
  });

  it("returns no key without identity", () => {
    expect(resolveContextKey(null, { env: {} })).toMatchObject({
      key: null,
      source: "none",
    });
  });

  it("sanitizes keys deterministically", () => {
    expect(sanitizeKey("  a/b c  ")).toBe("a_b_c");
    expect(sanitizeKey("...")).toBe("");
  });
});

describe("active task", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-state-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves a session-scoped pointer", () => {
    writeProject(root, "claude_abc", ".phronia/tasks/01-01-one");
    const state = resolveActiveTask({
      root,
      input: { session_id: "abc" },
      platform: "claude",
      env: {},
      io: nodeFs,
    });
    expect(state).toMatchObject({
      taskPath: ".phronia/tasks/01-01-one",
      sourceType: "session",
      stale: false,
    });
    expect(state.source).toBe("session:claude_abc");
  });

  it("marks a missing task directory as stale", () => {
    writeProject(root, "claude_abc", ".phronia/tasks/99-99-missing");
    const state = resolveActiveTask({
      root,
      input: { session_id: "abc" },
      platform: "claude",
      env: {},
      io: nodeFs,
    });
    expect(state.stale).toBe(true);
    expect(state.taskPath).toBe(".phronia/tasks/99-99-missing");
  });

  it("uses the single-session fallback only when exactly one file exists", () => {
    writeProject(root, "claude_abc", ".phronia/tasks/01-01-one");
    expect(
      resolveActiveTask({
        root,
        env: {},
        io: nodeFs,
        allowSingleSessionFallback: true,
      }).sourceType,
    ).toBe("session-fallback");

    writeSession(root, "claude_second", ".phronia/tasks/01-01-one");
    expect(
      resolveActiveTask({
        root,
        env: {},
        io: nodeFs,
        allowSingleSessionFallback: true,
      }).sourceType,
    ).toBe("none");
  });

  it("refuses refs that escape the repository", () => {
    writeProject(root, "claude_abc", "../../../outside");
    const resolved = resolveTaskRef("../../../outside", root, nodeFs);
    expect(resolved).toBeNull();
    const state = resolveActiveTask({
      root,
      input: { session_id: "abc" },
      platform: "claude",
      env: {},
      io: nodeFs,
    });
    expect(state.stale).toBe(true);
  });

  it("resolves tasks behind a symlinked workflow directory (#567)", () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-external-"));
    try {
      fs.mkdirSync(path.join(external, "tasks/01-01-one"), { recursive: true });
      fs.mkdirSync(path.join(external, ".runtime/sessions"), { recursive: true });
      fs.writeFileSync(
        path.join(external, ".runtime/sessions/claude_abc.json"),
        JSON.stringify({ current_task: ".phronia/tasks/01-01-one" }),
      );
      fs.symlinkSync(external, path.join(root, ".phronia"));

      const resolved = resolveTaskRef(".phronia/tasks/01-01-one", root, nodeFs);
      expect(resolved?.lexical.endsWith(".phronia/tasks/01-01-one")).toBe(true);
      const state = resolveActiveTask({
        root,
        input: { session_id: "abc" },
        platform: "claude",
        env: {},
        io: nodeFs,
      });
      expect(state.stale).toBe(false);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("shell tickets", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-ticket-"));
    fs.mkdirSync(path.join(root, ".phronia/tasks/01-01-one"), { recursive: true });
    fs.mkdirSync(path.join(root, ".phronia/.runtime/shell-tickets"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts one fresh matching ticket", () => {
    const now = 1000;
    writeTicket(root, "t1.json", {
      context_key: "claude_ticket",
      cwd: root,
      created_at_epoch: now - 5,
      subcommands: [{ name: "start", task_ref: ".phronia/tasks/01-01-one" }],
    });
    const result = lookupShellTicketContextKey({
      root,
      argv: ["task.py", "start", ".phronia/tasks/01-01-one"],
      now,
      io: nodeFs,
    });
    expect(result.key).toBe("claude_ticket");
  });

  it("refuses two matching tickets", () => {
    const now = 1000;
    writeTicket(root, "t1.json", {
      context_key: "a",
      cwd: root,
      created_at_epoch: now,
      subcommands: [{ name: "start", task_ref: ".phronia/tasks/01-01-one" }],
    });
    writeTicket(root, "t2.json", {
      context_key: "b",
      cwd: root,
      created_at_epoch: now,
      subcommands: [{ name: "start", task_ref: ".phronia/tasks/01-01-one" }],
    });
    const result = lookupShellTicketContextKey({
      root,
      argv: ["task.py", "start", ".phronia/tasks/01-01-one"],
      now,
      io: nodeFs,
    });
    expect(result.key).toBeNull();
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "state.session.ticket_ambiguous",
    );
  });

  it("ignores expired tickets", () => {
    const now = 1000;
    writeTicket(root, "t1.json", {
      context_key: "old",
      cwd: root,
      created_at_epoch: now - 60,
      subcommands: [{ name: "current" }],
    });
    expect(
      lookupShellTicketContextKey({
        root,
        argv: ["task.py", "current"],
        now,
        io: nodeFs,
      }).key,
    ).toBeNull();
  });
});

const PYTHON_PROBE = [
  "import json, os, sys",
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
  "from pathlib import Path",
  "from common.active_task import resolve_context_key, resolve_active_task",
  "payload = json.load(sys.stdin)",
  "sys.argv = payload['argv']",
  "input_data = payload['input']",
  "platform = payload['platform']",
  "key = resolve_context_key(input_data, platform)",
  "active = resolve_active_task(Path(payload['root']), input_data, platform,",
  "                             allow_single_session_fallback=payload['fallback'])",
  "print(json.dumps({'key': key,",
  "                  'task_path': active.task_path,",
  "                  'source_type': active.source_type,",
  "                  'context_key': active.context_key,",
  "                  'stale': active.stale}, sort_keys=True))",
].join("\n");

describe.skipIf(!pythonAvailable)("session parity with Python", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-parity-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cases: {
    name: string;
    sessionKey?: string;
    taskRef?: string;
    input?: unknown;
    platform?: string;
    env?: Record<string, string>;
    fallback?: boolean;
  }[] = [
    {
      name: "payload session",
      sessionKey: "claude_abc",
      taskRef: ".phronia/tasks/01-01-one",
      input: { session_id: "abc" },
      platform: "claude",
    },
    {
      name: "platform env",
      sessionKey: "codex_thread",
      taskRef: ".phronia/tasks/01-01-one",
      env: { CODEX_THREAD_ID: "thread" },
      platform: "codex",
    },
    {
      name: "single-session fallback",
      sessionKey: "claude_solo",
      taskRef: ".phronia/tasks/01-01-one",
      fallback: true,
    },
    {
      name: "no identity",
      taskRef: ".phronia/tasks/01-01-one",
    },
    {
      name: "stale pointer",
      sessionKey: "claude_abc",
      taskRef: ".phronia/tasks/99-99-missing",
      input: { session_id: "abc" },
      platform: "claude",
    },
  ];

  for (const testCase of cases) {
    it(`matches Python: ${testCase.name}`, () => {
      if (testCase.sessionKey && testCase.taskRef) {
        writeProject(root, testCase.sessionKey, testCase.taskRef);
      }
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...testCase.env,
      };
      const result = spawnSync("python3", ["-c", PYTHON_PROBE], {
        cwd: root,
        env,
        input: JSON.stringify({
          root,
          input: testCase.input ?? null,
          platform: testCase.platform ?? null,
          argv: ["task.py", "current"],
          fallback: testCase.fallback ?? false,
        }),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const expected = JSON.parse(result.stdout) as {
        key: string | null;
        task_path: string | null;
        source_type: string;
        context_key: string | null;
        stale: boolean;
      };

      const actual = resolveActiveTask({
        root,
        input: testCase.input,
        platform: testCase.platform,
        env,
        io: nodeFs,
        argv: ["task.py", "current"],
        allowSingleSessionFallback: testCase.fallback,
      });
      expect(actual.contextKey).toBe(expected.context_key);
      expect(actual.taskPath).toBe(expected.task_path);
      expect(actual.sourceType).toBe(expected.source_type);
      expect(actual.contextKey).toBe(expected.context_key);
      expect(actual.stale).toBe(expected.stale);
    });
  }
});

function writeProject(root: string, sessionKey: string, taskRef: string): void {
  fs.mkdirSync(path.join(root, ".phronia/tasks/01-01-one"), { recursive: true });
  writeSession(root, sessionKey, taskRef);
}

function writeSession(root: string, sessionKey: string, taskRef: string): void {
  const dir = path.join(root, ".phronia/.runtime/sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionKey}.json`),
    JSON.stringify({ platform: "claude", current_task: taskRef }),
  );
}

function writeTicket(
  root: string,
  name: string,
  ticket: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(root, ".phronia/.runtime/shell-tickets", name),
    JSON.stringify(ticket),
  );
}
