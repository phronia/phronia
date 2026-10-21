import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeProject,
  readFixture,
  writeFixture,
  writeMinimalProject,
} from "../src/fixtures.js";

const cleanups: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fixtures", () => {
  it("writes and reads a fixture round trip", async () => {
    const fixtureDir = path.join(await tempDir("fixture-"), "case");
    await writeFixture(fixtureDir, {
      input: { session_id: "id_fixture_1", cwd: "<PROJECT_ROOT>" },
      request: { schemaVersion: 1, event: "session-start" },
      expectedResponse: { blocks: [] },
      expectedHarness: "{}",
      meta: {
        platform: "claude",
        event: "session-start",
        recordedAt: "2026-01-01T00:00:00Z",
        source: "synthetic",
        redactionVersion: 1,
      },
    });

    const loaded = await readFixture(fixtureDir);
    expect(loaded.input).toEqual({ session_id: "id_fixture_1", cwd: "<PROJECT_ROOT>" });
    expect(loaded.request).toEqual({ schemaVersion: 1, event: "session-start" });
    expect(loaded.expectedResponse).toEqual({ blocks: [] });
    expect(loaded.expectedHarness).toBe("{}");
    expect(loaded.meta.platform).toBe("claude");
  });

  it("materializes a project and rewrites placeholders", async () => {
    const projectSource = await tempDir("project-");
    await writeMinimalProject(projectSource, { taskId: "01-01-fixture" });

    const fixtureDir = path.join(await tempDir("fixture-"), "case");
    await writeFixture(
      fixtureDir,
      {
        input: {},
        meta: {
          platform: "claude",
          event: "session-start",
          recordedAt: "2026-01-01T00:00:00Z",
          source: "synthetic",
          redactionVersion: 1,
        },
      },
      projectSource,
    );

    const destination = await tempDir("materialized-");
    const materialized = await materializeProject(fixtureDir, destination);
    const sessionFile = path.join(
      materialized.root,
      ".trellis",
      ".runtime",
      "sessions",
      "fixture-session.json",
    );
    const session = JSON.parse(await readFile(sessionFile, "utf8")) as {
      current_task: string;
    };
    expect(session.current_task).toBe(".trellis/tasks/01-01-fixture");
    expect(materialized.home.startsWith(destination)).toBe(true);
  });

  it("creates a stale pointer when the task directory is absent", async () => {
    const root = await tempDir("stale-");
    await writeMinimalProject(root, {
      taskId: "01-01-fixture",
      currentTask: ".trellis/tasks/99-99-missing",
    });
    const sessionFile = path.join(root, ".trellis", ".runtime", "sessions", "fixture-session.json");
    const session = JSON.parse(await readFile(sessionFile, "utf8")) as {
      current_task: string;
    };
    expect(session.current_task).toBe(".trellis/tasks/99-99-missing");
  });
});
