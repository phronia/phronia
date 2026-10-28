import { afterEach, describe, expect, it } from "vitest";
import { handleContext } from "../../src/context/index.js";
import type { ContextResponse } from "../../src/context/types.js";
import {
  GIT_AVAILABLE,
  createProject,
  type ProjectFixture,
} from "./runtime-fixture.js";

const PARENT = ".phronia/tasks/10-28-parent";
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
    event: "session-start",
    platform: { id: "claude-code" },
    projectRoot: root,
    input: { session_id: "abc" },
    env: { CLAUDE_PROJECT_DIR: root },
  });
}

function currentState(response: ContextResponse): string {
  return response.blocks.find((block) => block.id === "current-state")?.text ?? "";
}

describe.skipIf(!GIT_AVAILABLE)("session-start runtime-state", () => {
  it("adds the four fact lines for a parent task, without a next step", () => {
    const rootProject = project();
    rootProject.writeTask(PARENT, {
      status: "in_progress",
      children: CHILDREN,
    });
    for (const child of CHILDREN) {
      rootProject.writeTask(child, { status: "planning", parent: PARENT });
    }
    rootProject.writeSession("claude_abc", PARENT);

    const state = currentState(run(rootProject.root));

    expect(state).toContain("workspace: main (unclaimed)");
    expect(state).toContain("claim: none");
    expect(state).toContain("lease: none");
    expect(state).toContain(
      "parallel: 0 in_progress children (planning 6; total 6)",
    );
    expect(state).not.toContain("next:");
  });

  it("adds the four fact lines when no task is active", () => {
    const rootProject = project();

    const state = currentState(run(rootProject.root));

    expect(state).toContain("workspace: main (unclaimed)");
    expect(state).toContain("claim: none");
    expect(state).toContain("lease: none");
    expect(state).toContain("parallel: none");
  });
});

describe("session-start runtime-state read failure", () => {
  it("renders unknown (read failed) instead of omitting the lines", () => {
    const rootProject = project({ git: false });
    rootProject.writeTask(PARENT, {
      status: "in_progress",
      children: CHILDREN,
    });
    for (const child of CHILDREN) {
      rootProject.writeTask(child, { status: "planning", parent: PARENT });
    }
    rootProject.writeSession("claude_abc", PARENT);

    const state = currentState(run(rootProject.root));

    expect(state).toContain("workspace: unknown (read failed)");
    expect(state).toContain("claim: unknown (read failed)");
    expect(state).toContain("lease: unknown (read failed)");
    expect(state).toContain(
      "parallel: 0 in_progress children (planning 6; total 6)",
    );
  });
});
