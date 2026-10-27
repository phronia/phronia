#!/usr/bin/env node
/**
 * Real-world adoption acceptance suite.
 *
 * Clones each project pinned in `test/adopt/real-world-projects.json` at its
 * exact commit, copies it to a temporary directory, runs `phronia adopt`, and
 * checks both the migration result and the preserved user data.
 *
 * The fixture is cloned, never executed: only files written by Phronia are run
 * afterwards (the regenerated `task.py`). Pinning a commit keeps the suite
 * deterministic even when the upstream project moves on.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages/cli/dist/cli/index.js");
const MANIFEST = path.join(ROOT, "test/adopt/real-world-projects.json");
const PYTHON = process.env.PYTHON ?? "python3";

const args = process.argv.slice(2);
const selected = new Set();
const options = { keep: false, refresh: false, verbose: false };

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--project") {
    selected.add(args[++index]);
  } else if (arg.startsWith("--project=")) {
    selected.add(arg.slice("--project=".length));
  } else if (arg === "--keep") {
    options.keep = true;
  } else if (arg === "--refresh") {
    options.refresh = true;
  } else if (arg === "--verbose") {
    options.verbose = true;
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    printHelp();
    process.exit(2);
  }
}

if (!fs.existsSync(CLI)) {
  console.error(
    `Missing ${path.relative(ROOT, CLI)}. Run \`pnpm build\` before this suite.`,
  );
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const projects = (manifest.projects ?? []).filter(
  (project) => selected.size === 0 || selected.has(project.name),
);

if (projects.length === 0) {
  console.error("No matching projects in test/adopt/real-world-projects.json.");
  process.exit(2);
}

const cliVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packages/cli/package.json"), "utf8"),
).version;
const results = [];

for (const project of projects) {
  const result = { name: project.name, commit: project.commit, errors: [] };
  results.push(result);

  let workDir;
  try {
    const fixtureDir = ensureFixture(project);
    workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `phronia-adopt-${project.name}-`),
    );
    copyTree(fixtureDir, workDir);
    initGitRepo(workDir);

    log(options.verbose, `adopting ${project.name}@${short(project.commit)}`);
    const adoptRun = run(
      process.execPath,
      [
        CLI,
        "adopt",
        "--force",
        "--json",
        "--backup-root",
        path.join(workDir, ".adopt-backups"),
      ],
      { cwd: workDir, label: `${project.name}: adopt` },
    );
    const report = parseJson(adoptRun.stdout, `${project.name}: adopt output`);

    runChecks(project, workDir, report, result.errors);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  if (result.errors.length > 0) {
    result.workDir = workDir;
    reportProject(result, options.verbose);
    continue;
  }

  if (!options.keep && workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  reportProject(result, options.verbose);
}

const failed = results.filter((result) => result.errors.length > 0);
console.log(
  `\nReal-world adopt: ${results.length - failed.length}/${results.length} project(s) passed.`,
);
if (failed.length > 0) {
  for (const result of failed) {
    console.error(`\n${result.name} failed:`);
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    if (result.workDir) {
      console.error(`  kept: ${result.workDir}`);
    }
  }
  process.exit(1);
}

function ensureFixture(project) {
  if (!/^[0-9a-f]{40}$/.test(project.commit)) {
    throw new Error(`${project.name}: commit must be a full 40-char SHA`);
  }
  const cacheRoot =
    process.env.PHRONIA_ADOPT_CACHE ??
    path.join(os.homedir(), ".cache", "phronia-adopt-fixtures");
  const cacheDir = path.join(
    cacheRoot,
    `${project.name}-${project.commit.slice(0, 12)}`,
  );

  const currentHead = () => {
    try {
      return run("git", ["-C", cacheDir, "rev-parse", "HEAD"]).stdout.trim();
    } catch {
      return null;
    }
  };

  if (!options.refresh && currentHead() === project.commit) {
    log(options.verbose, `using cached ${cacheDir}`);
    return cacheDir;
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  log(options.verbose, `cloning ${project.repo}`);
  run("git", [
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    project.repo,
    cacheDir,
  ]);

  try {
    run("git", [
      "-C",
      cacheDir,
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "origin",
      project.commit,
    ]);
  } catch {
    // Some hosts refuse fetching an arbitrary SHA; download the history.
    run("git", ["-C", cacheDir, "fetch", "--quiet", "origin"]);
  }
  run("git", ["-C", cacheDir, "checkout", "--quiet", project.commit]);

  const actual = currentHead();
  if (actual !== project.commit) {
    throw new Error(
      `${project.name}: expected ${project.commit}, checked out ${actual ?? "nothing"}`,
    );
  }
  return cacheDir;
}

function copyTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    // The git metadata and any local build output are irrelevant and can be
    // large; the fixture is used only through its tracked files.
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== ".git" && name !== "target" && name !== "node_modules";
    },
  });
}

/** A clean repo keeps `adopt` and `update` on their normal code paths. */
function initGitRepo(directory) {
  run("git", ["init", "--quiet"], { cwd: directory });
  run("git", ["add", "-A"], { cwd: directory });
  run(
    "git",
    [
      "-c",
      "user.email=fixture@phronia.invalid",
      "-c",
      "user.name=phronia-fixture",
      "commit",
      "--quiet",
      "-m",
      "adopt fixture",
    ],
    { cwd: directory },
  );
}

function runChecks(project, workDir, report, errors) {
  const expect = project.expect ?? {};
  const check = (condition, message) => {
    if (!condition) {
      errors.push(message);
    }
  };
  const read = (relativePath) =>
    fs.readFileSync(path.join(workDir, ...relativePath.split("/")), "utf8");
  const exists = (relativePath) =>
    fs.existsSync(path.join(workDir, ...relativePath.split("/")));

  check(!exists(".trellis"), ".trellis/ still exists");
  check(exists(".phronia"), ".phronia/ was not created");
  check(
    report.fromVersion === project.fromVersion,
    `reported fromVersion=${report.fromVersion}, expected ${project.fromVersion}`,
  );
  check(report.backupDir && fs.existsSync(report.backupDir), "backup was not created");

  for (const platform of project.platforms ?? []) {
    check(
      (report.platforms ?? []).includes(platform),
      `platform ${platform} was not detected`,
    );
  }

  for (const relativePath of expect.preservedPaths ?? []) {
    check(exists(relativePath), `user content missing: ${relativePath}`);
  }

  for (const [month, count] of Object.entries(expect.archiveMonths ?? {})) {
    const monthDir = path.join(workDir, ".phronia/tasks/archive", month);
    const actual = fs.existsSync(monthDir)
      ? fs.readdirSync(monthDir, { withFileTypes: true }).filter((entry) =>
          entry.isDirectory(),
        ).length
      : 0;
    check(
      actual === count,
      `archive ${month}: expected ${count} tasks, found ${actual}`,
    );
  }

  const agentsMd = read("AGENTS.md");
  for (const text of expect.agentsMdMustContain ?? []) {
    check(agentsMd.includes(text), `AGENTS.md missing: ${text}`);
  }
  for (const text of expect.agentsMdMustNotContain ?? []) {
    check(!agentsMd.includes(text), `AGENTS.md still contains: ${text}`);
  }

  const workflow = read(".phronia/workflow.md");
  for (const text of expect.workflowMustContain ?? []) {
    check(workflow.includes(text), `.phronia/workflow.md missing: ${text}`);
  }
  for (const text of expect.workflowMustNotContain ?? []) {
    check(
      !workflow.includes(text),
      `.phronia/workflow.md still contains: ${text}`,
    );
  }

  check(
    read(".phronia/.version").trim() === cliVersion,
    `.phronia/.version does not match CLI ${cliVersion}`,
  );

  const layout = JSON.parse(read(".phronia/scripts/common/layout.json"));
  check(
    layout.rootDirName === ".phronia",
    `layout rootDirName=${layout.rootDirName}`,
  );

  const pathsPy = read(".phronia/scripts/common/paths.py");
  check(
    !pathsPy.includes('DIR_WORKFLOW = ".trellis"'),
    "paths.py still hardcodes the legacy root",
  );

  const hashes = JSON.parse(read(".phronia/.template-hashes.json"));
  check(hashes.__version === 3, `hash schema=${hashes.__version}`);
  check(hashes.brand === "phronia", `hash brand=${hashes.brand}`);
  const legacyKeys = Object.keys(hashes.hashes ?? {}).filter((key) =>
    key.startsWith(".trellis/"),
  );
  check(
    legacyKeys.length === 0,
    `template manifest still tracks ${legacyKeys.length} legacy path(s)`,
  );

  if (expect.tasksCommand) {
    const taskRun = run(
      PYTHON,
      [".phronia/scripts/task.py", ...expect.tasksCommand],
      { cwd: workDir, label: `${project.name}: task.py` },
    );
    for (const text of expect.tasksCommandMustContain ?? []) {
      check(
        taskRun.stdout.includes(text),
        `task.py ${expect.tasksCommand.join(" ")} output missing: ${text}`,
      );
    }
  }

  if (expect.updateDryRunMustContain) {
    const updateRun = run(process.execPath, [CLI, "update", "--dry-run"], {
      cwd: workDir,
      label: `${project.name}: update --dry-run`,
    });
    for (const text of expect.updateDryRunMustContain) {
      check(
        updateRun.stdout.includes(text),
        `update --dry-run output missing: ${text}`,
      );
    }
  }
}

function run(command, commandArgs, runOptions = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: runOptions.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${runOptions.label ?? command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${runOptions.label ?? command} exited ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function parseJson(content, label) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${label}: invalid JSON (${error instanceof Error ? error.message : error})\n${content.slice(0, 500)}`,
    );
  }
}

function reportProject(result, verbose) {
  if (result.errors.length === 0) {
    console.log(`✓ ${result.name}@${short(result.commit)}`);
    return;
  }
  console.log(`✗ ${result.name}@${short(result.commit)}`);
  if (verbose) {
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }
}

function short(commit) {
  return commit.slice(0, 12);
}

function log(verbose, message) {
  if (verbose) {
    console.log(`  ${message}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/test-adopt-real-world.mjs [options]

  --project <name>   Run one pinned project (repeatable)
  --refresh          Re-clone fixtures instead of reusing the cache
  --keep             Keep the temporary adoption worktree
  --verbose          Print commands and per-project detail
`);
}
