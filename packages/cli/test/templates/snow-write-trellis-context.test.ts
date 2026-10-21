/**
 * Execute Snow's write-phronia-context.py for session / user / subagent modes.
 *
 * The hook is a thin adapter over `phronia context`; these tests spawn the real
 * Python hook against a fixture repo so the Snow JSON envelope, log breadcrumb
 * policy, UTF-8 byte limits, and session isolation stay pinned.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HOOK_SCRIPT = path.join(
  path.dirname(__filename),
  "..",
  "..",
  "src",
  "templates",
  "snow",
  "hooks",
  "write-phronia-context.py",
);
const CLI_PATH = path.join(process.cwd(), "dist", "cli", "index.js");

function resolvePython(): string | null {
  for (const candidate of ["python", "python3", process.env.PYTHON ?? ""]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = resolvePython();

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  payload: { additionalContext?: string; display?: string } | null;
}

function sessionKey(sessionId: string): string {
  return `snow_${sessionId}`;
}

function writeFixtureRepo(root: string): void {
  const taskDir = path.join(root, ".phronia", "tasks", "demo-task");
  fs.mkdirSync(path.join(root, ".phronia", "spec", "guides"), { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia", ".runtime", "sessions"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(taskDir, "task.json"),
    JSON.stringify({ id: "demo-task", title: "Demo", status: "in_progress" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(taskDir, "prd.md"),
    "# Demo PRD\n\nAcceptance: snow hook inject works.\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(taskDir, "implement.jsonl"),
    JSON.stringify({ file: ".phronia/spec/guides/index.md", reason: "guides" }) + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(root, ".phronia", "spec", "guides", "index.md"),
    "# Guides body\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(root, ".phronia", "workflow.md"),
    "# Workflow\n\n## Phase Index\nPhase 1: Plan\n\n[workflow-state:in_progress]\nExecute the task.\n[/workflow-state:in_progress]\n",
    "utf-8",
  );
}

function linkSession(root: string, sessionId: string): void {
  fs.writeFileSync(
    path.join(root, ".phronia", ".runtime", "sessions", `${sessionKey(sessionId)}.json`),
    JSON.stringify({ current_task: ".phronia/tasks/demo-task" }),
    "utf-8",
  );
}

function runHook(
  repo: string,
  mode: "session" | "user" | "subagent",
  opts: {
    stdin?: string;
    env?: Record<string, string | undefined>;
  } = {},
): HookResult {
  if (!PYTHON) {
    throw new Error("Python is required for snow hook execution tests");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SNOW_CWD: repo,
    PHRONIA_CLI_PATH: CLI_PATH,
    // Avoid leaking host Phronia session identity into fixture runs.
    PHRONIA_CONTEXT_ID: "",
    SNOW_SESSION_ID: opts.env?.SNOW_SESSION_ID ?? "",
    ...opts.env,
  };

  const result = spawnSync(
    PYTHON,
    ["-X", "utf8", HOOK_SCRIPT, mode],
    {
      cwd: repo,
      env,
      encoding: "utf-8",
      input: opts.stdin ?? "",
      windowsHide: true,
      timeout: 30_000,
    },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let payload: HookResult["payload"] = null;
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);
  if (line) {
    try {
      payload = JSON.parse(line) as HookResult["payload"];
    } catch {
      payload = null;
    }
  }

  return {
    status: result.status,
    stdout,
    stderr,
    payload,
  };
}

describe("snow write-phronia-context.py execution", () => {
  const tmpRoots: string[] = [];

  function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-snow-hook-"));
    tmpRoots.push(root);
    writeFixtureRepo(root);
    return root;
  }

  function cleanup(): void {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it.skipIf(!PYTHON)(
    "session mode emits the core session plan and writes the full log",
    () => {
      const repo = makeRepo();
      try {
        linkSession(repo, "sess-session-1");
        const res = runHook(repo, "session", {
          stdin: JSON.stringify({
            sessionId: "sess-session-1",
            cwd: repo,
            isResume: false,
          }),
          env: { SNOW_SESSION_ID: "sess-session-1" },
        });

        expect(res.status).toBe(0);
        expect(res.payload).not.toBeNull();
        expect(res.payload?.additionalContext).toContain("<session-context>");
        expect(res.payload?.additionalContext).toContain("<current-state>");
        expect(res.payload?.additionalContext).toContain("demo-task");
        expect(res.payload?.display).toContain("Phronia session context injected");

        const logPath = path.join(repo, ".snow", "log", "phronia-context.txt");
        expect(fs.existsSync(logPath)).toBe(true);
        const log = fs.readFileSync(logPath, "utf-8");
        expect(log).toContain("<current-state>");
        expect(log).toContain("<task-status>");
        expect(log).toContain("demo-task");
      } finally {
        cleanup();
      }
    },
  );

  it.skipIf(!PYTHON)(
    "user mode injects the compact breadcrumb but preserves a full log snapshot",
    () => {
      const repo = makeRepo();
      try {
        linkSession(repo, "sess-user-1");
        const res = runHook(repo, "user", {
          stdin: JSON.stringify({
            sessionId: "sess-user-1",
            cwd: repo,
            message: "hello",
            source: "normal",
          }),
          env: { SNOW_SESSION_ID: "sess-user-1" },
        });

        expect(res.status).toBe(0);
        expect(res.payload?.additionalContext).toContain("<workflow-state>");
        expect(res.payload?.additionalContext).toContain("Task: demo-task");
        // Compact inject must not embed the full session snapshot.
        expect(res.payload?.additionalContext).not.toContain("<current-state>");
        expect(res.payload?.display).toContain("Phronia compact breadcrumb");

        const log = fs.readFileSync(
          path.join(repo, ".snow", "log", "phronia-context.txt"),
          "utf-8",
        );
        expect(log).toContain("<current-state>");
        expect(log).toContain("demo-task");
      } finally {
        cleanup();
      }
    },
  );

  it.skipIf(!PYTHON)(
    "subagent mode materializes role-specific context",
    () => {
      const repo = makeRepo();
      try {
        linkSession(repo, "sess-sub-1");

        const implement = runHook(repo, "subagent", {
          stdin: JSON.stringify({
            sessionId: "sess-sub-1",
            cwd: repo,
            agentId: "phronia-implement",
            agentName: "phronia-implement",
            prompt: "Active task: .phronia/tasks/demo-task\nImplement feature",
          }),
          env: { SNOW_SESSION_ID: "sess-sub-1" },
        });
        expect(implement.status).toBe(0);
        expect(implement.payload?.additionalContext).toContain("# Demo PRD");
        expect(implement.payload?.additionalContext).toContain("Guides body");
        expect(implement.payload?.additionalContext).not.toContain(
          "Implement Agent Task",
        );
        expect(implement.payload?.display).toContain("phronia-implement");

        const research = runHook(repo, "subagent", {
          stdin: JSON.stringify({
            sessionId: "sess-sub-1",
            cwd: repo,
            agentName: "phronia-research",
            prompt: "research topic",
          }),
          env: { SNOW_SESSION_ID: "sess-sub-1" },
        });
        expect(research.status).toBe(0);
        expect(research.payload?.additionalContext).toContain(
          "Project Spec Directory Structure",
        );
        expect(research.payload?.display).toContain("phronia-research");
      } finally {
        cleanup();
      }
    },
  );

  it.skipIf(!PYTHON)(
    "does not pick another session runtime file by mtime",
    () => {
      const repo = makeRepo();
      try {
        linkSession(repo, "mine-session");
        const sessionsDir = rootSessions(repo);
        // Newer foreign session should NOT be selected when current id is known.
        fs.writeFileSync(
          path.join(sessionsDir, "foreign-session.json"),
          JSON.stringify({ owner: "other", secret: "DO-NOT-LEAK" }),
          "utf-8",
        );
        const future = Date.now() + 60_000;
        fs.utimesSync(
          path.join(sessionsDir, "foreign-session.json"),
          future / 1000,
          future / 1000,
        );

        const res = runHook(repo, "session", {
          stdin: JSON.stringify({
            sessionId: "mine-session",
            cwd: repo,
            isResume: true,
          }),
          env: {
            SNOW_SESSION_ID: "mine-session",
            PHRONIA_CONTEXT_ID: "snow_mine-session",
          },
        });

        expect(res.status).toBe(0);
        const body = res.payload?.additionalContext ?? "";
        expect(body).toContain("demo-task");
        expect(body).not.toContain("DO-NOT-LEAK");
      } finally {
        cleanup();
      }
    },
  );

  it.skipIf(!PYTHON)("enforces _truncate limits in UTF-8 bytes", () => {
    if (!PYTHON) return;
    // Import helpers by executing a tiny driver against the hook module.
    const driver = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("wtc", r"${HOOK_SCRIPT.replace(/\\/g, "/")}")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
text = "中" * 200 + "a" * 200
out = mod._truncate(text, 50)
print(json.dumps({"bytes": len(out.encode("utf-8")), "has_marker": "truncated" in out}))
`;
    const res = spawnSync(PYTHON, ["-X", "utf8", "-c", driver], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as {
      bytes: number;
      has_marker: boolean;
    };
    expect(parsed.bytes).toBeLessThanOrEqual(50);
    expect(parsed.has_marker).toBe(true);
  });

  it.skipIf(!PYTHON)("fail-open returns JSON on unexpected errors", () => {
    const repo = makeRepo();
    try {
      const res = runHook(repo, "session", { stdin: "" });
      expect(res.status).toBe(0);
      expect(res.payload).not.toBeNull();
      expect(typeof res.payload?.additionalContext).toBe("string");
      expect(typeof res.payload?.display).toBe("string");
    } finally {
      cleanup();
    }
  });
});

function rootSessions(repo: string): string {
  return path.join(repo, ".phronia", ".runtime", "sessions");
}
