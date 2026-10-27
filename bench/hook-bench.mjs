#!/usr/bin/env node
/**
 * Hook cold-start baseline.
 *
 * Runs each shared hook against the repository's own `.phronia/` state and
 * reports p50/p95/p99 wall time. The numbers are a baseline, not a gate:
 * B3 (context core) and B10 (binary) compare against them, and CI archives
 * the JSON.
 *
 * Usage:
 *   node bench/hook-bench.mjs [--iterations 30] [--out bench/baseline.json]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOKS_DIR = path.join(REPO_ROOT, "packages/cli/src/templates/shared-hooks");
const RUNTIME_DIR = path.join(REPO_ROOT, ".phronia/.runtime/sessions");
const SESSION_KEY = `bench-${process.pid}`;
const SESSION_FILE = path.join(RUNTIME_DIR, `${SESSION_KEY}.json`);

const args = parseArgs(process.argv.slice(2));
const iterations = Number(args.iterations ?? process.env.BENCH_ITERATIONS ?? 30);
const outputPath = args.out ? path.resolve(REPO_ROOT, args.out) : null;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=");
      parsed[name] = inline ?? argv[index + 1];
      if (inline === undefined) {
        index += 1;
      }
    }
  }
  return parsed;
}

function activeTaskRef() {
  const tasksDir = path.join(REPO_ROOT, ".phronia/tasks");
  if (!existsSync(tasksDir)) {
    return null;
  }
  const task = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .sort((a, b) => a.name.localeCompare(b.name))
    .at(0);
  return task ? `.phronia/tasks/${task.name}` : null;
}

function installSession() {
  const taskRef = activeTaskRef();
  if (!taskRef) {
    throw new Error("No task directory found under .phronia/tasks; create one before benchmarking.");
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    SESSION_FILE,
    `${JSON.stringify(
      {
        platform: "bench",
        last_seen_at: new Date().toISOString(),
        session_id: SESSION_KEY,
        current_task: taskRef,
        current_run: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return taskRef;
}

function cleanup() {
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    // Best effort: the runtime directory is gitignored.
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    iterations: sorted.length,
    minMs: round(sorted[0]),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    meanMs: round(total / sorted.length),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function time(command, commandArgs, { input, env } = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(command, commandArgs, {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    elapsedMs: elapsed,
    status: result.status,
    stdoutBytes: Buffer.byteLength(result.stdout ?? "", "utf8"),
    stderr: (result.stderr ?? "").slice(0, 400),
  };
}

const cases = [
  {
    name: "python-startup",
    command: "python3",
    args: ["-c", "pass"],
    input: undefined,
  },
  {
    name: "session-start",
    command: "python3",
    args: [path.join(HOOKS_DIR, "session-start.py")],
    input: JSON.stringify({ cwd: REPO_ROOT, session_id: SESSION_KEY }),
  },
  {
    name: "workflow-state",
    command: "python3",
    args: [path.join(HOOKS_DIR, "inject-workflow-state.py")],
    input: JSON.stringify({ cwd: REPO_ROOT, session_id: SESSION_KEY, prompt: "benchmark" }),
  },
  {
    name: "subagent-context",
    command: "python3",
    args: [path.join(HOOKS_DIR, "inject-subagent-context.py")],
    input: JSON.stringify({
      cwd: REPO_ROOT,
      session_id: SESSION_KEY,
      tool_name: "Task",
      tool_input: { subagent_type: "trellis-implement", prompt: "benchmark" },
    }),
  },
  {
    name: "pre-shell",
    command: "python3",
    args: [path.join(HOOKS_DIR, "inject-shell-session-context.py")],
    input: JSON.stringify({
      cwd: REPO_ROOT,
      session_id: SESSION_KEY,
      tool_name: "Bash",
      tool_input: { command: "python3 ./.phronia/scripts/task.py current" },
    }),
  },
];

function main() {
  const taskRef = installSession();
  const results = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    python: spawnSync("python3", ["--version"], { encoding: "utf8" }).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    repoRoot: REPO_ROOT,
    taskRef,
    iterations,
    cases: [],
  };

  try {
    for (const testCase of cases) {
      for (let index = 0; index < 3; index += 1) {
        time(testCase.command, testCase.args, { input: testCase.input });
      }
      const samples = [];
      let lastStatus = 0;
      let lastStderr = "";
      let stdoutBytes = 0;
      for (let index = 0; index < iterations; index += 1) {
        const run = time(testCase.command, testCase.args, { input: testCase.input });
        samples.push(run.elapsedMs);
        lastStatus = run.status ?? 1;
        lastStderr = run.stderr;
        stdoutBytes = run.stdoutBytes;
      }
      results.cases.push({
        name: testCase.name,
        ...summarize(samples),
        exitStatus: lastStatus,
        stdoutBytes,
        stderr: lastStderr,
      });
      process.stderr.write(
        `${testCase.name.padEnd(20)} p50=${round(percentile([...samples].sort((a, b) => a - b), 0.5))}ms p95=${round(percentile([...samples].sort((a, b) => a - b), 0.95))}ms status=${lastStatus}\n`,
      );
    }
  } finally {
    cleanup();
  }

  const json = `${JSON.stringify(results, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json, "utf8");
    process.stderr.write(`Wrote ${outputPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

main();
