#!/usr/bin/env node
/**
 * Shim artifact guard.
 *
 * Shims are the only code that talks to a harness. They must stay small,
 * carry a version stamp, and never re-implement context assembly. The
 * recorded line ceilings are ratchets: raise one only when a new harness API
 * genuinely needs the code, never to accommodate business logic.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages/cli/src/templates");
const SHIM_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, "packages/cli/package.json"), "utf8"),
).version;

// Each entry: file/dir, adapter stamp, line ceiling (code lines, no comments
// or blanks), forbidden assembly markers.
const RULES = [
  {
    glob: "opencode/plugins",
    adapter: "opencode@v1",
    maxLines: 240,
    forbidden: [/readJsonl/i, /materialize/i, /resolveTaskDir/, /buildContextFrom/],
  },
  {
    glob: "opencode/lib",
    adapter: "opencode@v1",
    maxLines: 220,
    forbidden: [/readJsonl/i, /materialize/i, /current_task/],
  },
  {
    glob: "omp/extensions/phronia/index.ts.txt",
    adapter: "omp@v1",
    maxLines: 380,
    forbidden: [/readContextInjectionLimits/, /buildTaskContext/, /parseWorkflowStateBlocks/],
  },
  {
    glob: "pi/extensions/phronia/index.ts.txt",
    adapter: "pi@v1",
    // Pi keeps tool UI, subagent orchestration, and permission forwarding; the
    // context assembly itself is gone. Ratchet down in B10.
    maxLines: 1700,
    forbidden: [/readContextInjectionLimits/, /buildContext\(/, /parseWorkflowStateBlocks/],
  },
  {
    glob: "snow/hooks/write-phronia-context.py",
    adapter: "snow@v1",
    maxLines: 330,
    forbidden: [/build_context/, /_task_artifact_summary/, /get_context\.py/],
  },
  {
    glob: "shared-hooks/phronia-hook.py",
    adapter: "shared@v1",
    maxLines: 260,
    forbidden: [/readJsonl/i, /materialize/i],
  },
];

function filesFor(relative) {
  const full = path.join(CLI, relative);
  try {
    const stat = statSync(full);
    if (stat.isFile()) return [full];
  } catch {
    return [];
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(js|mjs|cjs|ts|txt|py)$/.test(entry.name)) out.push(child);
    }
  };
  walk(full);
  return out;
}

function codeLines(text) {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("#");
  }).length;
}

function hasStamp(text, adapter) {
  return new RegExp(`phronia-shim:\\s*${adapter.replace("@", "@")}`).test(text);
}

function stampFor(adapter, isPython) {
  const prefix = isPython ? "#" : "//";
  return [
    `${prefix} phronia-shim: ${adapter}`,
    `${prefix} shim-version: ${SHIM_VERSION}`,
    `${prefix} DO NOT EDIT. Regenerate with: phronia update --regenerate-shims`,
  ].join("\n");
}

function insertStamp(text, adapter, file) {
  const isPython = file.endsWith(".py");
  const stamp = stampFor(adapter, isPython);
  if (isPython) {
    // Keep shebang/encoding first so the interpreter and PEP 263 still work.
    const lines = text.split("\n");
    let index = 0;
    while (index < lines.length && /^#!|^# -\*- coding/.test(lines[index])) index++;
    lines.splice(index, 0, stamp, "");
    return lines.join("\n");
  }
  const marker = "/* global process */\n";
  if (text.startsWith(marker)) {
    return `${marker}${stamp}\n${text.slice(marker.length)}`;
  }
  return `${stamp}\n${text}`;
}

const problems = [];
let checked = 0;
const write = process.argv.includes("--write");

for (const rule of RULES) {
  for (const file of filesFor(rule.glob)) {
    checked += 1;
    const relative = path.relative(ROOT, file);
    let text = readFileSync(file, "utf8");
    const isPython = file.endsWith(".py");
    if (!hasStamp(text, rule.adapter)) {
      if (write) {
        text = insertStamp(text, rule.adapter, file);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, text, "utf8");
      } else {
        problems.push(`${relative}: missing "phronia-shim: ${rule.adapter}" stamp`);
      }
    }
    const lines = codeLines(text);
    if (lines > rule.maxLines) {
      problems.push(`${relative}: ${lines} code lines exceeds ${rule.maxLines}`);
    }
    for (const forbidden of rule.forbidden) {
      if (forbidden.test(text)) {
        problems.push(`${relative}: contains shared assembly marker ${forbidden}`);
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`shim guard failed (${problems.length} problem(s), ${checked} files checked)`);
  process.exit(1);
}
console.log(`shim guard ok (${checked} files, shim ${SHIM_VERSION})`);
