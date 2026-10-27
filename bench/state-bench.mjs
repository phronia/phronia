#!/usr/bin/env node
/**
 * State-reader cold/warm benchmark.
 *
 * Measures the work B3 will do on every session start (open + config + active
 * task + workflow overview). Run after `pnpm build:core`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openState } from "../packages/core/dist/state/index.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 100);

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

function run(label, fn) {
  for (let index = 0; index < 5; index += 1) fn();
  const samples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const sorted = samples.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(28)} p50=${percentile(sorted, 0.5).toFixed(2)}ms p95=${percentile(sorted, 0.95).toFixed(2)}ms`,
  );
}

run("openState", () => {
  openState({ root: REPO_ROOT });
});
run("config", () => {
  openState({ root: REPO_ROOT }).config();
});
run("active task", () => {
  openState({ root: REPO_ROOT, argv: ["task.py", "current"] }).sessions.active(
    { session_id: "bench" },
    { platform: "claude" },
  );
});
run("tasks list", () => {
  openState({ root: REPO_ROOT }).tasks.list();
});
run("workflow overview", () => {
  openState({ root: REPO_ROOT }).workflow.overview();
});
