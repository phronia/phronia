import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseBreadcrumbs,
  promptHasSkipKeyword,
  resolveBreadcrumbKey,
  buildBreadcrumb,
} from "../../src/state/workflow/breadcrumb.js";
import {
  extractRange,
  stripBreadcrumbTagBlocks,
  buildWorkflowOverview,
} from "../../src/state/workflow/phase.js";
import {
  collectSpecIndexPaths,
  resolveSpecScope,
} from "../../src/state/spec/index.js";
import { nodeFs } from "../../src/state/fs.js";
import { openState } from "../../src/state/index.js";

const WORKFLOW = [
  "# Workflow",
  "",
  "## Phase Index",
  "",
  "```",
  "Phase 1: Plan",
  "```",
  "",
  "[workflow-state:planning]",
  "Planning body",
  "[/workflow-state:planning]",
  "",
  "<!-- internal comment -->",
  "[some-other-tag]",
  "",
  "## Phase 1: Plan",
  "",
  "Detail",
  "",
  "## Phase 2: Execute",
  "",
].join("\n");

describe("workflow breadcrumbs", () => {
  it("parses tag blocks", () => {
    const breadcrumbs = parseBreadcrumbs(WORKFLOW);
    expect(breadcrumbs).toEqual({ planning: "Planning body" });
  });

  it("matches skip keywords with hyphen-aware boundaries", () => {
    expect(promptHasSkipKeyword("no-trellis please", "no-trellis")).toBe(true);
    expect(promptHasSkipKeyword("No-Trellis", "no-trellis")).toBe(true);
    expect(promptHasSkipKeyword("xno-trellis", "no-trellis")).toBe(false);
    expect(promptHasSkipKeyword("no-trellisx", "no-trellis")).toBe(false);
    expect(promptHasSkipKeyword("foo-no-trellis", "no-trellis")).toBe(false);
    expect(promptHasSkipKeyword("anything", "")).toBe(false);
  });

  it("selects the Codex inline key", () => {
    expect(resolveBreadcrumbKey("planning", "auto")).toBe("planning");
    expect(resolveBreadcrumbKey("planning", "inline")).toBe("planning-inline");
  });

  it("builds the breadcrumb envelope", () => {
    expect(
      buildBreadcrumb({ status: "in_progress", taskId: "01-01-x", body: "body" }),
    ).toBe("<workflow-state>\nTask: 01-01-x (in_progress)\nbody\n</workflow-state>");
    expect(buildBreadcrumb({ status: "no_task", taskId: null, body: undefined })).toContain(
      "Refer to workflow.md for current step.",
    );
  });
});

describe("phase overview", () => {
  it("extracts the range and strips hook-owned tags", () => {
    expect(extractRange(WORKFLOW, "Phase Index", "Phase 1: Plan")).toContain(
      "Phase 1: Plan",
    );
    const stripped = stripBreadcrumbTagBlocks(
      extractRange(WORKFLOW, "Phase Index", "Phase 1: Plan"),
    );
    expect(stripped).not.toContain("workflow-state");
    expect(stripped).not.toContain("internal comment");
    expect(stripped).not.toContain("some-other-tag");
  });

  it("builds a compact overview", () => {
    const overview = buildWorkflowOverview(WORKFLOW, ".phronia/workflow.md");
    expect(overview).toContain("# Development Workflow - Session Summary");
    expect(overview).toContain(".phronia/scripts/get_context.py");
  });

  it("reports a missing workflow file", () => {
    expect(buildWorkflowOverview(null, ".phronia/workflow.md")).toBe(
      "No workflow.md found",
    );
  });
});

describe("spec scope", () => {
  const packages = {
    cli: { path: "packages/cli" },
    core: { path: "packages/core" },
  };

  it("returns null for single-repo or unconfigured scope", () => {
    expect(
      resolveSpecScope({
        packages: null,
        scope: null,
        taskPackage: null,
        defaultPackage: null,
      }).packages,
    ).toBeNull();
    expect(
      resolveSpecScope({
        packages,
        scope: null,
        taskPackage: null,
        defaultPackage: null,
      }).packages,
    ).toBeNull();
  });

  it("resolves active_task with task and default fallbacks", () => {
    expect(
      resolveSpecScope({
        packages,
        scope: "active_task",
        taskPackage: "cli",
        defaultPackage: "core",
      }).packages,
    ).toEqual(new Set(["cli"]));
    expect(
      resolveSpecScope({
        packages,
        scope: "active_task",
        taskPackage: "missing",
        defaultPackage: "core",
      }).packages,
    ).toEqual(new Set(["core"]));
  });

  it("filters explicit scopes and warns on unknown packages", () => {
    const result = resolveSpecScope({
      packages,
      scope: ["cli", "missing"],
      taskPackage: "core",
      defaultPackage: null,
    });
    expect(result.packages).toEqual(new Set(["cli"]));
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["state.spec.unknown_package", "state.spec.task_out_of_scope"]),
    );
  });

  it("falls back to task/default/full when every entry is invalid", () => {
    const result = resolveSpecScope({
      packages,
      scope: ["nope"],
      taskPackage: "core",
      defaultPackage: null,
    });
    expect(result.packages).toEqual(new Set(["core"]));
    expect(result.diagnostics.map((item) => item.code)).toContain("state.spec.scope_fallback");
  });
});

describe("spec index paths", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-spec-"));
    fs.mkdirSync(path.join(root, ".phronia/spec/guides"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/spec/guides/index.md"), "# guides");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists guides and package indexes", () => {
    fs.mkdirSync(path.join(root, ".phronia/spec/cli"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/spec/cli/index.md"), "# cli");
    expect(collectSpecIndexPaths(root, nodeFs, null)).toEqual([
      ".phronia/spec/guides/index.md",
      ".phronia/spec/cli/index.md",
    ]);
  });

  it("falls back to nested layer indexes and respects scope", () => {
    fs.mkdirSync(path.join(root, ".phronia/spec/cli/backend"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/spec/cli/backend/index.md"), "# be");
    fs.mkdirSync(path.join(root, ".phronia/spec/core/backend"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/spec/core/backend/index.md"), "# be");
    expect(collectSpecIndexPaths(root, nodeFs, new Set(["cli"]))).toEqual([
      ".phronia/spec/guides/index.md",
      ".phronia/spec/cli/backend/index.md",
    ]);
  });

  it("is exposed through openState", () => {
    fs.mkdirSync(path.join(root, ".phronia/spec/cli"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/spec/cli/index.md"), "# cli");
    fs.writeFileSync(
      path.join(root, ".phronia/workflow.md"),
      WORKFLOW,
    );
    const reader = openState({ root, fs: nodeFs });
    expect(reader.workflow.overview()).toContain("Development Workflow");
    expect(reader.workflow.breadcrumbs()).toEqual({ planning: "Planning body" });
    expect(reader.spec.indexPaths()).toContain(".phronia/spec/cli/index.md");
  });
});
