import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFs } from "../../src/state/fs.js";
import { readTaskRecord } from "../../src/state/tasks/record.js";
import {
  countCuratedEntries,
  inspectTaskArtifacts,
} from "../../src/state/tasks/artifacts.js";
import { listTasks } from "../../src/state/tasks/list.js";
import { openState } from "../../src/state/index.js";

describe("task state", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-tasks-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads a canonical record and tolerates unknown fields", () => {
    writeTask(root, "01-01-one", {
      id: "one",
      title: "First",
      status: "in_progress",
      package: "cli",
      branch: "phronia/one",
      unknown_field: { keep: true },
    });
    const record = readTaskRecord(root, ".phronia/tasks/01-01-one", nodeFs);
    expect(record).toMatchObject({
      id: "one",
      title: "First",
      status: "in_progress",
      package: "cli",
      branch: "phronia/one",
    });
    expect(record?.raw.unknown_field).toEqual({ keep: true });
  });

  it("returns null with a diagnostic for a corrupt record", () => {
    const dir = path.join(root, ".phronia/tasks/01-01-bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), "{ not json");
    const diagnostics: Parameters<typeof readTaskRecord>[3] = [];
    expect(readTaskRecord(root, ".phronia/tasks/01-01-bad", nodeFs, diagnostics)).toBeNull();
    expect(diagnostics.map((item) => item.code)).toContain("state.task.record_corrupt");
  });

  it("reports artifact presence and curated JSONL rows", () => {
    const taskDir = writeTask(root, "01-01-one", { id: "one", title: "First" });
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# PRD");
    fs.writeFileSync(path.join(taskDir, "design.md"), "# Design");
    fs.mkdirSync(path.join(taskDir, "research"));
    fs.writeFileSync(
      path.join(taskDir, "implement.jsonl"),
      [
        JSON.stringify({ _example: "seed" }),
        JSON.stringify({ file: ".phronia/spec/a.md", reason: "a" }),
        JSON.stringify({ path: ".phronia/spec/b.md" }),
        "not json",
      ].join("\n"),
    );

    const artifacts = inspectTaskArtifacts(root, ".phronia/tasks/01-01-one", nodeFs);
    expect(artifacts).toMatchObject({
      prd: true,
      design: true,
      implement: false,
      implementJsonl: true,
      research: true,
    });
    const diagnostics: Parameters<typeof countCuratedEntries>[4] = [];
    expect(
      countCuratedEntries(
        root,
        ".phronia/tasks/01-01-one",
        "implement",
        nodeFs,
        diagnostics,
      ),
    ).toBe(2);
    expect(diagnostics.map((item) => item.code)).toContain("state.task.jsonl_malformed");
  });

  it("detects spec-delta.md as a task artifact", () => {
    const taskDir = writeTask(root, "01-01-one", { id: "one", title: "First" });
    expect(
      inspectTaskArtifacts(root, ".phronia/tasks/01-01-one", nodeFs),
    ).toMatchObject({ specDelta: false, sizes: {} });

    fs.writeFileSync(path.join(taskDir, "spec-delta.md"), "# Spec Delta\n");
    const artifacts = inspectTaskArtifacts(
      root,
      ".phronia/tasks/01-01-one",
      nodeFs,
    );
    expect(artifacts.specDelta).toBe(true);
    expect(artifacts.sizes["spec-delta.md"]).toBe(Buffer.byteLength("# Spec Delta\n"));
  });

  it("lists active and archived tasks in ref order", () => {
    writeTask(root, "01-01-a", { id: "a", title: "A" });
    writeTask(root, "02-02-b", { id: "b", title: "B" });
    writeArchivedTask(root, "2026-10", "03-03-c", { id: "c", title: "C" });

    const active = listTasks(root, nodeFs);
    expect(active.map((task) => task.ref)).toEqual([
      ".phronia/tasks/01-01-a",
      ".phronia/tasks/02-02-b",
    ]);

    const all = listTasks(root, nodeFs, { includeArchived: true });
    expect(all.map((task) => task.ref)).toContain(
      ".phronia/tasks/archive/2026-10/03-03-c",
    );
    expect(all.find((task) => task.id === "c")?.archived).toBe(true);
  });

  it("refuses refs outside the repository", () => {
    expect(readTaskRecord(root, "../../../etc", nodeFs)).toBeNull();
  });

  it("exposes tasks through openState", () => {
    writeTask(root, "01-01-one", { id: "one", title: "First" });
    const reader = openState({ root, fs: nodeFs });
    expect(reader.tasks.read(".phronia/tasks/01-01-one")?.id).toBe("one");
    expect(reader.tasks.list()).toHaveLength(1);
  });
});

function writeTask(
  root: string,
  name: string,
  fields: Record<string, unknown>,
): string {
  const dir = path.join(root, ".phronia/tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(fields));
  return dir;
}

function writeArchivedTask(
  root: string,
  month: string,
  name: string,
  fields: Record<string, unknown>,
): void {
  const dir = path.join(root, ".phronia/tasks/archive", month, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(fields));
}
