import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSubagentSpawn,
  normalizeAgentType,
} from "../../src/context/subagent/index.js";
import {
  Budget,
  isBinaryContent,
  materializeFile,
  truncateUtf8,
} from "../../src/context/subagent/materialize.js";
import type { ContextRequest } from "../../src/context/types.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const HOOK = path.join(REPO_ROOT, ".claude/hooks/inject-subagent-context.py");
const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

describe("agent type normalization", () => {
  it("accepts current and legacy names", () => {
    expect(normalizeAgentType("phronia-implement")).toBe("implement");
    expect(normalizeAgentType("trellis-check")).toBe("check");
    expect(normalizeAgentType("research")).toBe("research");
    expect(normalizeAgentType("unknown")).toBeNull();
  });
});

describe("materialization limits", () => {
  it("truncates without splitting UTF-8 sequences", () => {
    const data = Buffer.from("aé中", "utf8");
    // "a" + 2-byte é = 3 bytes; cutting at 2 leaves a valid prefix.
    expect(truncateUtf8(data, 2).toString("utf8")).toBe("a");
    expect(truncateUtf8(data, 0)).toEqual(data);
    expect(truncateUtf8(data, 100)).toEqual(data);
  });

  it("detects binary content", () => {
    expect(isBinaryContent(Buffer.from([0, 1, 2]))).toBe(true);
    expect(isBinaryContent(Buffer.from("hello", "utf8"))).toBe(false);
    expect(isBinaryContent(Buffer.from([0xff, 0xfe]))).toBe(true);
  });

  it("emits truncation and binary notices", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-mat-"));
    try {
      fs.mkdirSync(path.join(root, ".phronia/spec"), { recursive: true });
      fs.writeFileSync(path.join(root, ".phronia/spec/long.md"), "x".repeat(100));
      fs.writeFileSync(path.join(root, ".phronia/spec/bin.md"), Buffer.from([0, 1]));
      const limits = { maxFileBytes: 10, maxArtifactBytes: 10, maxTotalBytes: 1000 };
      expect(
        materializeFile(root, ".phronia/spec/long.md", "r", limits, new Budget(1000)),
      ).toContain("truncated at 10 bytes");
      expect(
        materializeFile(root, ".phronia/spec/bin.md", "r", limits, new Budget(1000)),
      ).toContain("not inlined (binary file)");
      expect(
        materializeFile(root, "../outside.md", "r", limits, new Budget(1000)),
      ).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!pythonAvailable)("subagent prompt parity", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-subagent-"));
    seed(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const [agentType, prompt] of [
    ["phronia-implement", "implement this"],
    ["phronia-check", "check this"],
    ["phronia-research", "research this"],
    ["phronia-check", "[finish] final check"],
  ] as const) {
    it(`matches Python for ${agentType} (${prompt})`, () => {
      const payload = {
        cwd: root,
        session_id: "abc",
        tool_name: "Task",
        tool_input: { subagent_type: agentType, prompt },
      };
      const python = spawnSync("python3", [HOOK], {
        cwd: root,
        input: JSON.stringify(payload),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLAUDE_PROJECT_DIR: root,
        },
        encoding: "utf8",
      });
      expect(python.status, python.stderr).toBe(0);
      const parsed = JSON.parse(python.stdout) as {
        hookSpecificOutput: { updatedInput?: { prompt?: string } };
      };
      const expected = parsed.hookSpecificOutput.updatedInput?.prompt;
      expect(expected).toBeTruthy();

      const response = buildSubagentSpawn(request(root, payload));
      const mutation = response.mutations[0];
      expect(mutation?.op).toBe("set-prompt");
      if (mutation?.op !== "set-prompt") return;
      expect(mutation.value).toBe(expected);
    });
  }
});

function request(root: string, input: unknown): ContextRequest {
  return {
    schemaVersion: 1,
    event: "subagent-spawn",
    platform: { id: "claude-code" },
    projectRoot: root,
    input,
    env: { CLAUDE_PROJECT_DIR: root },
  };
}

function seed(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/spec/guides"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/spec/cli/backend"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/tasks/01-01-one"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia/.runtime/sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".phronia/config.yaml"), "session_auto_commit: false\n");
  fs.writeFileSync(path.join(root, ".phronia/spec/guides/index.md"), "# guides");
  fs.writeFileSync(path.join(root, ".phronia/spec/cli/backend/index.md"), "# backend");

  fs.writeFileSync(
    path.join(root, ".phronia/tasks/01-01-one/task.json"),
    JSON.stringify({ id: "one", title: "One", status: "in_progress" }),
  );
  fs.writeFileSync(path.join(root, ".phronia/tasks/01-01-one/prd.md"), "# PRD body");
  fs.writeFileSync(path.join(root, ".phronia/tasks/01-01-one/design.md"), "# Design body");
  fs.writeFileSync(
    path.join(root, ".phronia/tasks/01-01-one/implement.jsonl"),
    `${JSON.stringify({ file: ".phronia/spec/cli/backend/index.md", reason: "backend" })}\n`,
  );
  fs.writeFileSync(
    path.join(root, ".phronia/tasks/01-01-one/check.jsonl"),
    `${JSON.stringify({ file: ".phronia/spec/guides/index.md", reason: "guides" })}\n`,
  );
  fs.symlinkSync(
    path.join(REPO_ROOT, "packages/cli/src/templates/workflow/scripts"),
    path.join(root, ".phronia/scripts"),
  );
  fs.writeFileSync(
    path.join(root, ".phronia/.runtime/sessions/claude_abc.json"),
    JSON.stringify({ platform: "claude", current_task: ".phronia/tasks/01-01-one" }),
  );
}
