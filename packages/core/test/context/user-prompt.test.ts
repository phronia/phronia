import { afterEach, describe, expect, it } from "vitest";
import { handleContext } from "../../src/context/index.js";
import type { ContextResponse } from "../../src/context/types.js";
import {
  GIT_AVAILABLE,
  createProject,
  type ProjectFixture,
} from "./runtime-fixture.js";

const PARENT = ".phronia/tasks/10-28-parent";
const LEAF = ".phronia/tasks/10-28-leaf";
const CHILDREN = Array.from(
  { length: 6 },
  (_, index) => `.phronia/tasks/10-28-child-${index + 1}`,
);

const projects: ProjectFixture[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) {
    project.cleanup();
  }
});

function project(options: { git?: boolean } = {}): ProjectFixture {
  const created = createProject(options);
  projects.push(created);
  return created;
}

function run(root: string): ContextResponse {
  return handleContext({
    schemaVersion: 1,
    event: "user-prompt",
    platform: { id: "claude-code" },
    projectRoot: root,
    input: { session_id: "abc", prompt: "continue" },
    env: { CLAUDE_PROJECT_DIR: root },
  });
}

function blockText(response: ContextResponse, id: string): string {
  return response.blocks.find((block) => block.id === id)?.text ?? "";
}

function seedParent(rootProject: ProjectFixture): void {
  rootProject.writeTask(PARENT, {
    status: "in_progress",
    children: CHILDREN,
  });
  for (const child of CHILDREN) {
    rootProject.writeTask(child, { status: "planning", parent: PARENT });
  }
  rootProject.writeSession("claude_abc", PARENT);
}

describe.skipIf(!GIT_AVAILABLE)("user-prompt runtime-state", () => {
  it("reports a parent task and the start-a-child next step", () => {
    const rootProject = project();
    seedParent(rootProject);

    const response = run(rootProject.root);
    const runtime = blockText(response, "runtime-state");

    expect(runtime).toContain("workspace: main (unclaimed)");
    expect(runtime).toContain("claim: none");
    expect(runtime).toContain("lease: none");
    expect(runtime).toContain(
      "parallel: 0 in_progress children (planning 6; total 6)",
    );
    expect(runtime).toContain(
      "next: start a child before dispatching implement/check (children: 6)",
    );

    const workflow = blockText(response, "workflow-state");
    expect(workflow).toContain("Execute body.");
    expect(workflow).not.toContain("runtime-state");
  });

  it("reports a leaf task's claim and lease without a next step", () => {
    const rootProject = project();
    rootProject.writeTask(LEAF, { status: "in_progress" });
    rootProject.writeSession("claude_abc", LEAF);
    rootProject.writeClaim({ taskRef: LEAF, ownerRef: `task:${LEAF}` });
    rootProject.writeLease(LEAF, {});

    const runtime = blockText(run(rootProject.root), "runtime-state");

    expect(runtime).toContain(`workspace: main (claimed by task ${LEAF})`);
    expect(runtime).toContain(`claim: task ${LEAF}`);
    expect(runtime).toContain("lease: session session-1");
    expect(runtime).toContain("parallel: serial");
    expect(runtime).not.toContain("next:");
  });

  it("renders a session claim ownerRef exactly once", () => {
    const rootProject = project();
    rootProject.writeTask(LEAF, { status: "in_progress" });
    rootProject.writeSession("claude_abc", LEAF);
    rootProject.writeClaim({ taskRef: null, ownerRef: "session:abc" });

    const runtime = blockText(run(rootProject.root), "runtime-state");

    expect(runtime).toContain("workspace: main (claimed by session:abc)");
    expect(runtime).toContain("claim: session:abc");
    expect(runtime).not.toContain("session session:abc");
  });

  it("renders read failures as unknown instead of omitting the lines", () => {
    const rootProject = project({ git: false });
    rootProject.writeTask(LEAF, { status: "in_progress" });
    rootProject.writeSession("claude_abc", LEAF);

    const runtime = blockText(run(rootProject.root), "runtime-state");

    expect(runtime).toContain("workspace: unknown (read failed)");
    expect(runtime).toContain("claim: unknown (read failed)");
    expect(runtime).toContain("lease: unknown (read failed)");
    expect(runtime).toContain("parallel: serial");
  });

  it("does not read or emit runtime facts without an active task", () => {
    const rootProject = project();

    const response = run(rootProject.root);

    expect(blockText(response, "workflow-state")).toContain("No task yet.");
    expect(response.blocks.some((block) => block.id === "runtime-state")).toBe(
      false,
    );
  });
});
