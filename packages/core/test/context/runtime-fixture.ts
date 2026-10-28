import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sharedRuntimePaths,
  taskLeasePath,
} from "../../src/state/shared-runtime.js";

export const GIT_AVAILABLE =
  spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

const WORKFLOW = [
  "# Workflow",
  "",
  "[workflow-state:no_task]",
  "No task yet. Create one when the user describes real work.",
  "[/workflow-state:no_task]",
  "",
  "[workflow-state:planning]",
  "Planning body.",
  "[/workflow-state:planning]",
  "",
  "[workflow-state:in_progress]",
  "Execute body.",
  "[/workflow-state:in_progress]",
  "",
].join("\n");

export interface ProjectFixture {
  readonly root: string;
  writeTask(ref: string, task: Record<string, unknown>): void;
  writeSession(key: string, taskRef: string | null): void;
  writeClaim(claim: Record<string, unknown>): void;
  writeLease(taskRef: string, lease: Record<string, unknown>): void;
  cleanup(): void;
}

export function createProject(
  options: { git?: boolean } = {},
): ProjectFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-runtime-"));
  fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, ".phronia/tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".phronia/config.yaml"),
    "session_auto_commit: false\n",
  );
  fs.writeFileSync(path.join(root, ".phronia/workflow.md"), WORKFLOW);
  if (options.git !== false && GIT_AVAILABLE) {
    spawnSync("git", ["init", "-q"], { cwd: root });
  }

  const runtimePaths = (): ReturnType<typeof sharedRuntimePaths> =>
    sharedRuntimePaths(path.join(root, ".git"));

  return {
    root,
    writeTask(ref, task) {
      const dir = path.join(root, ref);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "task.json"),
        JSON.stringify({
          id: path.basename(dir),
          title: path.basename(dir),
          status: "planning",
          ...task,
        }),
      );
    },
    writeSession(key, taskRef) {
      fs.writeFileSync(
        path.join(root, ".phronia/.runtime/sessions", `${key}.json`),
        JSON.stringify({ platform: "claude", current_task: taskRef }),
      );
    },
    writeClaim(claim) {
      const file = path.join(root, ".git/phronia/workspace.claim.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          ownerType: "task",
          ownerRef: "task:fixture",
          sessionKey: "session-1",
          taskRef: null,
          workspace: root,
          branch: "main",
          host: "host",
          pid: 1,
          state: "in_progress",
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          ttlSeconds: 3600,
          ...claim,
        }),
      );
    },
    writeLease(taskRef, lease) {
      const file = taskLeasePath(runtimePaths(), taskRef);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          taskRef,
          ownerType: "session",
          ownerId: "session-1",
          sessionKey: "session-1",
          workspace: root,
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          ttlSeconds: 3600,
          ...lease,
        }),
      );
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
