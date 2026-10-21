import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  readSpecStatuses,
  writeSpecStatus,
} from "../src/spec/status.js";
import {
  projectRequirements,
  renderRequirements,
  writeRequirements,
} from "../src/docs/requirements.js";

describe("spec status frontmatter", () => {
  it("treats a file without frontmatter as verified", () => {
    expect(parseFrontmatter("# Title\n\nBody\n")).toEqual({ status: "verified" });
  });

  it("reads phronia draft metadata", () => {
    expect(
      parseFrontmatter(
        ["---", "phronia:", "  status: draft", "  owner: alice", "---", "# Body"].join("\n"),
      ),
    ).toMatchObject({ status: "draft", owner: "alice" });
  });
});

describe("spec status files", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-spec-status-"));
    const dir = path.join(root, ".phronia/spec/cli/backend");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "one.md"), "# Verified\n");
    fs.writeFileSync(
      path.join(dir, "two.md"),
      ["---", "phronia:", "  status: draft", "---", "", "# Draft"].join("\n"),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("counts statuses across the spec tree", () => {
    const summary = readSpecStatuses(root);
    expect(summary.counts).toEqual({ draft: 1, verified: 1, deprecated: 0 });
  });

  it("writes verification metadata without touching the body", () => {
    expect(
      writeSpecStatus(root, ".phronia/spec/cli/backend/two.md", "verified", {
        by: "bob",
        at: "2026-10-21",
      }),
    ).toBe(true);
    const content = fs.readFileSync(
      path.join(root, ".phronia/spec/cli/backend/two.md"),
      "utf8",
    );
    expect(content).toContain("status: verified");
    expect(content).toContain("verified_by: bob");
    expect(content).toContain("# Draft");
    expect(content.match(/^---$/gm)).toHaveLength(2);
  });
});

describe("requirements projection", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-requirements-"));
    const taskDir = path.join(root, ".phronia/tasks/10-20-demo");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        id: "10-20-demo",
        title: "Demo task",
        status: "in_progress",
        package: "cli",
        createdAt: "2026-10-20",
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("projects the task ledger deterministically", () => {
    const rows = projectRequirements(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "10-20-demo", status: "in_progress" });
    const first = renderRequirements(root);
    expect(renderRequirements(root)).toBe(first);
    expect(first).toContain("| `10-20-demo` | Demo task | in_progress | cli | 2026-10-20 |");
  });

  it("detects a stale generated document without writing in check mode", () => {
    const result = writeRequirements(root, { check: true });
    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.join(root, "docs/requirements.md"))).toBe(false);
    const written = writeRequirements(root);
    expect(written.changed).toBe(true);
    expect(writeRequirements(root, { check: true }).changed).toBe(false);
  });
});
