/**
 * Fixture layout and I/O.
 *
 * A fixture is a recorded harness payload plus the smallest `.trellis/`
 * snapshot needed to reproduce its context, and the expected outputs of the
 * core and of the harness envelope. Everything is plain files so a fixture
 * can be reviewed in a pull request.
 *
 *   <fixture>/
 *     input.json             raw harness payload (redacted)
 *     request.json           optional: ContextRequest built by the shim
 *     expected-response.json optional: core response
 *     expected-harness.txt   optional: rendered harness output (text or JSON)
 *     project/               minimal project snapshot
 *     meta.json              provenance and provenance/version data
 */

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type FixtureEvent =
  | "session-start"
  | "user-prompt"
  | "pre-tool-use"
  | "pre-shell"
  | "subagent-spawn"
  | "session-end";

export interface FixtureMeta {
  platform: string;
  adapterId?: string;
  event: FixtureEvent;
  harnessVersion?: string | null;
  recordedAt: string;
  source: "real" | "synthetic";
  redactionVersion: number;
  payloadKeys?: string[];
  notes?: string;
}

export interface FixtureContents {
  input: unknown;
  request?: unknown;
  expectedResponse?: unknown;
  expectedHarness?: string;
  meta: FixtureMeta;
}

export interface MaterializedProject {
  root: string;
  home: string;
}

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".py",
  ".toml",
  ".sh",
]);

export async function writeFixture(
  fixtureDir: string,
  fixture: FixtureContents,
  projectSource?: string,
): Promise<void> {
  await mkdir(fixtureDir, { recursive: true });
  await writeJson(path.join(fixtureDir, "input.json"), fixture.input);
  await writeJson(path.join(fixtureDir, "meta.json"), fixture.meta, false);

  if (fixture.request !== undefined) {
    await writeJson(path.join(fixtureDir, "request.json"), fixture.request);
  }
  if (fixture.expectedResponse !== undefined) {
    await writeJson(path.join(fixtureDir, "expected-response.json"), fixture.expectedResponse);
  }
  if (fixture.expectedHarness !== undefined) {
    await writeFile(path.join(fixtureDir, "expected-harness.txt"), fixture.expectedHarness, "utf8");
  }
  if (projectSource) {
    await cp(projectSource, path.join(fixtureDir, "project"), { recursive: true });
  }
}

export async function readFixture(fixtureDir: string): Promise<FixtureContents> {
  const meta = await readJson<FixtureMeta>(path.join(fixtureDir, "meta.json"));
  const fixture: FixtureContents = {
    input: await readJson<unknown>(path.join(fixtureDir, "input.json")),
    meta,
  };

  const request = await readJsonIfExists(path.join(fixtureDir, "request.json"));
  if (request !== undefined) {
    fixture.request = request;
  }
  const expectedResponse = await readJsonIfExists(path.join(fixtureDir, "expected-response.json"));
  if (expectedResponse !== undefined) {
    fixture.expectedResponse = expectedResponse;
  }
  const expectedHarness = await readTextIfExists(path.join(fixtureDir, "expected-harness.txt"));
  if (expectedHarness !== undefined) {
    fixture.expectedHarness = expectedHarness;
  }
  return fixture;
}

/**
 * Copy a fixture's project snapshot into a fresh directory and point its
 * placeholders at the new location. Returns the project root and a fake home
 * directory so tests never touch the real one.
 */
export async function materializeProject(
  fixtureDir: string,
  destination: string,
): Promise<MaterializedProject> {
  await mkdir(destination, { recursive: true });
  const source = path.join(fixtureDir, "project");
  const root = path.join(destination, "project");
  const home = path.join(destination, "home");
  await cp(source, root, { recursive: true });
  await mkdir(home, { recursive: true });

  await replacePlaceholders(root, {
    "<PROJECT_ROOT>": root,
    "<HOME>": home,
  });
  return { root, home };
}

/**
 * Snapshot selected paths from a live repository into a fixture directory.
 * Only explicit paths are copied: a fixture must stay small and reviewable.
 */
export async function snapshotPaths(
  repoRoot: string,
  destination: string,
  relativePaths: readonly string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    const source = path.join(repoRoot, relativePath);
    if (!(await exists(source))) {
      continue;
    }
    const target = path.join(destination, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

export interface MinimalProjectOptions {
  taskId?: string;
  taskStatus?: "planning" | "in_progress" | "completed";
  sessionKey?: string;
  currentTask?: string | null;
  workflowStates?: readonly string[];
  config?: string;
}

/**
 * Write a minimal, deterministic `.trellis/` project used by fixtures and
 * tool self-tests. It intentionally contains only what context assembly reads.
 */
export async function writeMinimalProject(
  root: string,
  options: MinimalProjectOptions = {},
): Promise<void> {
  const taskId = options.taskId ?? "01-01-fixture-task";
  const taskDir = path.join(root, ".trellis", "tasks", taskId);
  await mkdir(path.join(root, ".trellis", ".runtime", "sessions"), { recursive: true });
  await mkdir(taskDir, { recursive: true });

  await writeFile(
    path.join(root, ".trellis", "config.yaml"),
    options.config ?? "session_auto_commit: false\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".trellis", "workflow.md"),
    [
      "# Workflow",
      "",
      "## Phase Index",
      "",
      "- Phase 1: Plan",
      "- Phase 2: Execute",
      "- Phase 3: Finish",
      "",
      "## Phase 1: Plan",
      "",
      ...(options.workflowStates ?? []),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeJson(
    path.join(taskDir, "task.json"),
    {
      id: taskId,
      name: taskId.replace(/^\d{2}-\d{2}-/, ""),
      title: "Fixture task",
      description: "Synthetic task for contract fixtures.",
      status: options.taskStatus ?? "in_progress",
      dev_type: "backend",
      scope: "cli",
      package: "cli",
      priority: "P1",
      creator: "fixture",
      assignee: "fixture",
      createdAt: "2026-01-01",
      completedAt: null,
      branch: null,
      base_branch: "main",
      worktree_path: null,
      commit: null,
      pr_url: null,
      subtasks: [],
      children: [],
      parent: null,
      relatedFiles: [],
      notes: "",
      meta: {},
    },
    false,
  );
  await writeFile(path.join(taskDir, "prd.md"), "# Fixture task\n\nSynthetic PRD.\n", "utf8");
  await writeFile(
    path.join(taskDir, "implement.jsonl"),
    `${JSON.stringify({ file: ".trellis/spec/guides/index.md", reason: "fixture" })}\n`,
    "utf8",
  );
  await writeFile(path.join(taskDir, "check.jsonl"), "", "utf8");

  const sessionKey = options.sessionKey ?? "fixture-session";
  await writeJson(path.join(root, ".trellis", ".runtime", "sessions", `${sessionKey}.json`), {
    platform: "fixture",
    last_seen_at: "2026-01-01T00:00:00Z",
    current_task:
      options.currentTask === undefined
        ? `.trellis/tasks/${taskId}`
        : options.currentTask,
    current_run: null,
  });
}

export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function replacePlaceholders(
  root: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await replacePlaceholders(fullPath, replacements);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    const content = await readFile(fullPath, "utf8");
    let next = content;
    for (const [from, to] of Object.entries(replacements)) {
      next = next.split(from).join(to);
    }
    if (next !== content) {
      await writeFile(fullPath, next, "utf8");
    }
  }
}

async function writeJson(target: string, value: unknown, indent = true): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, indent ? 2 : 0)}\n`, "utf8");
}

async function readJson<T>(target: string): Promise<T> {
  return JSON.parse(await readFile(target, "utf8")) as T;
}

async function readJsonIfExists(target: string): Promise<unknown> {
  if (!(await exists(target))) {
    return undefined;
  }
  return JSON.parse(await readFile(target, "utf8")) as unknown;
}

async function readTextIfExists(target: string): Promise<string | undefined> {
  if (!(await exists(target))) {
    return undefined;
  }
  return readFile(target, "utf8");
}
