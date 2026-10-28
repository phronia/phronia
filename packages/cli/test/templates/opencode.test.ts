import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findUserTextPart,
  insertSyntheticTextPart,
  MESSAGES_TRANSFORM_HOOK,
  prependEphemeralText,
} from "../../src/templates/opencode/adapters/v1/lib/context-visibility.js";
import {
  contextCollector,
  hasInjectedTrellisContext,
  isTrellisSubagent,
} from "../../src/templates/opencode/adapters/v1/lib/session-utils.js";
import injectSubagentContextPlugin from "../../src/templates/opencode/adapters/v1/plugins/inject-subagent-context.js";
import sessionStartPlugin from "../../src/templates/opencode/adapters/v1/plugins/session-start.js";
import injectWorkflowStatePlugin from "../../src/templates/opencode/adapters/v1/plugins/inject-workflow-state.js";

beforeAll(() => {
  process.env.PHRONIA_CLI_PATH = join(
    process.cwd(),
    "dist/cli/index.js",
  );
});

interface TestContextCollector {
  processed: Set<string>;
  markProcessed(directory: string, sessionID: string): void;
  isProcessed(directory: string, sessionID: string): boolean;
  clear(sessionID: string): void;
}

interface OpenCodeInjectHooks {
  "tool.execute.before": (
    input: unknown,
    output: { args: { command: string } },
  ) => Promise<void>;
}

async function createOpenCodeInjectHooks(
  platform: NodeJS.Platform = "linux",
  env: NodeJS.ProcessEnv = {},
): Promise<OpenCodeInjectHooks> {
  return (await injectSubagentContextPlugin({
    directory: "/tmp/phronia-opencode-test",
    platform,
    env,
  })) as OpenCodeInjectHooks;
}

interface ChatMessagePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface TransformMessage {
  info: { role: string; sessionID?: string; agent?: string };
  parts: ChatMessagePart[];
}

interface TransformHooks {
  "experimental.chat.messages.transform": (
    input: object,
    output: { messages: TransformMessage[] },
  ) => Promise<void>;
}

function createUserTextPart(
  text: string,
  sessionID = "main-session",
  messageID = "message-a",
  ordinal = "000000000010",
): ChatMessagePart {
  return {
    id: `prt_${ordinal}abcdefghijklmn`,
    sessionID,
    messageID,
    type: "text",
    text,
  };
}

function userTurn(
  text: string,
  opts: { sessionID?: string; agent?: string; messageID?: string } = {},
): TransformMessage {
  const sessionID = opts.sessionID ?? "main-session";
  return {
    info: {
      role: "user",
      sessionID,
      agent: opts.agent ?? "build",
    },
    parts: [createUserTextPart(text, sessionID, opts.messageID)],
  };
}

describe("opencode session context dedupe", () => {
  let collector: TestContextCollector;

  beforeEach((): void => {
    collector = contextCollector as TestContextCollector;
  });

  afterEach((): void => {
    collector.clear("session-a");
    collector.clear("session-b");
    collector.processed.clear();
  });

  it("tracks processed sessions in memory for the active process", () => {
    expect(collector.isProcessed("session-a")).toBe(false);

    collector.markProcessed("session-a");
    expect(collector.isProcessed("session-a")).toBe(true);

    collector.clear("session-a");

    expect(collector.isProcessed("session-a")).toBe(false);
  });

  it("does not treat a different session id as already processed", () => {
    collector.markProcessed("session-a");

    expect(collector.isProcessed("session-b")).toBe(false);
  });
});

describe("opencode session-start history detection", () => {
  afterEach((): void => {
    contextCollector.clear("session-a");
  });

  it("detects persisted Phronia context from metadata", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [
          {
            type: "text",
            text: "hello",
            metadata: {
              trellis: {
                sessionStart: true,
              },
            },
          },
        ],
      },
    ];

    expect(hasInjectedTrellisContext(messages)).toBe(true);
  });

  it("ignores unrelated user messages", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [
          {
            type: "text",
            text: "normal prompt",
          },
        ],
      },
    ];

    expect(hasInjectedTrellisContext(messages)).toBe(false);
  });
});

describe("opencode bash session context", () => {
  it("injects PHRONIA_CONTEXT_ID into Bash commands from plugin sessionID", async () => {
    const hooks = await createOpenCodeInjectHooks();
    const output = {
      args: {
        command: "python3 ./.phronia/scripts/task.py start .phronia/tasks/demo",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; python3 ./.phronia/scripts/task.py start .phronia/tasks/demo",
    );
  });

  it("uses PowerShell environment syntax on Windows", async () => {
    const hooks = await createOpenCodeInjectHooks("win32");
    const output = {
      args: {
        command: "python ./.phronia/scripts/task.py start .phronia/tasks/demo",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "$env:PHRONIA_CONTEXT_ID = 'opencode_oc-a'; python ./.phronia/scripts/task.py start .phronia/tasks/demo",
    );
  });

  it("uses POSIX environment syntax on Windows Git Bash", async () => {
    const hooks = await createOpenCodeInjectHooks("win32", {
      MSYSTEM: "MINGW64",
    });
    const output = {
      args: {
        command: "git diff --name-only",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; git diff --name-only",
    );
  });

  it("uses POSIX environment syntax when Windows OSTYPE indicates MSYS", async () => {
    const hooks = await createOpenCodeInjectHooks("win32", {
      OSTYPE: "msys",
    });
    const output = {
      args: {
        command: "git status --short",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; git status --short",
    );
  });

  it("uses POSIX environment syntax when Windows MINGW_PREFIX is set", async () => {
    const hooks = await createOpenCodeInjectHooks("win32", {
      MINGW_PREFIX: "/mingw64",
    });
    const output = {
      args: {
        command: "git log --oneline -1",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; git log --oneline -1",
    );
  });

  it("uses POSIX environment syntax when Windows SHELL is bash", async () => {
    const hooks = await createOpenCodeInjectHooks("win32", {
      SHELL: "/usr/bin/bash",
    });
    const output = {
      args: {
        command: "git branch --show-current",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; git branch --show-current",
    );
  });

  it("uses POSIX environment syntax when OpenCode Git Bash path is configured", async () => {
    const hooks = await createOpenCodeInjectHooks("win32", {
      OPENCODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    const output = {
      args: {
        command: "git rev-parse --show-toplevel",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; git rev-parse --show-toplevel",
    );
  });

  it("does not duplicate an explicit PHRONIA_CONTEXT_ID assignment", async () => {
    const hooks = await createOpenCodeInjectHooks();
    const output = {
      args: {
        command:
          "PHRONIA_CONTEXT_ID=manual python3 ./.phronia/scripts/task.py current",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "PHRONIA_CONTEXT_ID=manual python3 ./.phronia/scripts/task.py current",
    );
  });

  it("does not duplicate an explicit exported PHRONIA_CONTEXT_ID", async () => {
    const hooks = await createOpenCodeInjectHooks();
    const output = {
      args: {
        command:
          "export PHRONIA_CONTEXT_ID=manual; python3 ./.phronia/scripts/task.py current",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID=manual; python3 ./.phronia/scripts/task.py current",
    );
  });

  it("does not duplicate an explicit env PHRONIA_CONTEXT_ID assignment", async () => {
    const hooks = await createOpenCodeInjectHooks();
    const output = {
      args: {
        command:
          "env FOO=bar PHRONIA_CONTEXT_ID=manual python3 ./.phronia/scripts/task.py current",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "env FOO=bar PHRONIA_CONTEXT_ID=manual python3 ./.phronia/scripts/task.py current",
    );
  });

  it("does not duplicate an explicit PowerShell PHRONIA_CONTEXT_ID assignment", async () => {
    const hooks = await createOpenCodeInjectHooks("win32");
    const output = {
      args: {
        command:
          "$env:PHRONIA_CONTEXT_ID = 'manual'; python ./.phronia/scripts/task.py current",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "$env:PHRONIA_CONTEXT_ID = 'manual'; python ./.phronia/scripts/task.py current",
    );
  });

  it("does not treat a grep pattern as an explicit PHRONIA_CONTEXT_ID assignment", async () => {
    const hooks = await createOpenCodeInjectHooks();
    const output = {
      args: {
        command: "env | sort | grep '^PHRONIA_CONTEXT_ID='",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "oc-a" },
      output,
    );

    expect(output.args.command).toBe(
      "export PHRONIA_CONTEXT_ID='opencode_oc-a'; env | sort | grep '^PHRONIA_CONTEXT_ID='",
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #264 — sub-agent context injection + transform skip
// ---------------------------------------------------------------------------

interface TaskToolOutput {
  args: {
    subagent_type?: string;
    prompt?: string;
  };
}

interface TaskToolHooks {
  "tool.execute.before": (
    input: { tool: string; sessionID?: string; agent?: string },
    output: TaskToolOutput,
  ) => Promise<void>;
}

describe("opencode persisted synthetic context parts", () => {
  it("creates deterministic complete identities without changing ordinary parts", () => {
    const ordinary = createUserTextPart("original prompt");
    ordinary.metadata = { user: { preserved: true } };
    const firstParts = [structuredClone(ordinary)];
    const secondParts = [structuredClone(ordinary)];

    const first = insertSyntheticTextPart(
      firstParts,
      "session context",
      "sessionStart",
    );
    const second = insertSyntheticTextPart(
      secondParts,
      "session context",
      "sessionStart",
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      sessionID: "main-session",
      messageID: "message-a",
      type: "text",
      text: "session context",
      synthetic: true,
    });
    expect(first.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(firstParts[1]).toEqual(ordinary);
    expect(secondParts[1]).toEqual(ordinary);
  });

  it("keeps both insertion orders equal to ID-sorted replay order", () => {
    for (const order of [
      ["sessionStart", "workflowState"],
      ["workflowState", "sessionStart"],
    ]) {
      const ordinary = createUserTextPart("ordinary user prompt");
      const parts = [structuredClone(ordinary)];

      for (const kind of order) {
        insertSyntheticTextPart(
          parts,
          kind === "sessionStart" ? "session context" : "workflow context",
          kind,
        );
      }

      expect(parts.map(part => part.text)).toEqual([
        "session context",
        "workflow context",
        "ordinary user prompt",
      ]);
      expect(parts.map(part => part.id)).toEqual(
        [...parts]
          .sort((left, right) =>
            left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
          )
          .map(part => part.id),
      );
      expect(parts[0].id).not.toBe(parts[1].id);
      expect(parts[2]).toEqual(ordinary);
      expect(findUserTextPart(parts)).toBe(parts[2]);
    }
  });

  it("rejects unsupported kinds, missing identities, and duplicate IDs before mutation", () => {
    const unsupportedParts = [createUserTextPart("prompt")];
    const unsupportedBefore = structuredClone(unsupportedParts);
    expect(() =>
      insertSyntheticTextPart(unsupportedParts, "context", "unknown"),
    ).toThrow("unknown context part kind");
    expect(unsupportedParts).toEqual(unsupportedBefore);

    const unsupportedIdentityParts = [
      createUserTextPart(
        "prompt",
        "main-session",
        "message-low-ordinal",
        "000000000001",
      ),
    ];
    const unsupportedIdentityBefore = structuredClone(
      unsupportedIdentityParts,
    );
    expect(() =>
      insertSyntheticTextPart(
        unsupportedIdentityParts,
        "context",
        "sessionStart",
      ),
    ).toThrow("unsupported OpenCode part ID ordinal");
    expect(unsupportedIdentityParts).toEqual(unsupportedIdentityBefore);

    const missingIdentityParts: ChatMessagePart[] = [
      { type: "text", text: "prompt" },
    ];
    const missingIdentityBefore = structuredClone(missingIdentityParts);
    expect(() =>
      insertSyntheticTextPart(
        missingIdentityParts,
        "context",
        "sessionStart",
      ),
    ).toThrow("no ordinary OpenCode part with a persisted identity");
    expect(missingIdentityParts).toEqual(missingIdentityBefore);

    const duplicateParts = [createUserTextPart("prompt")];
    insertSyntheticTextPart(duplicateParts, "context", "workflowState");
    const duplicateBefore = structuredClone(duplicateParts);
    expect(() =>
      insertSyntheticTextPart(duplicateParts, "context", "workflowState"),
    ).toThrow("duplicate synthetic context part");
    expect(duplicateParts).toEqual(duplicateBefore);
  });

  it("fails closed on a legacy 19-character OpenCode part ID format without mutating parts", () => {
    // OpenCode has changed its part ID format before: a live DB observed 5 of
    // 2440 IDs still using this older, shorter shape. PART_ID_PATTERN must
    // reject it rather than silently treat it as a valid identity source.
    const legacyParts: ChatMessagePart[] = [
      {
        id: "prt_19b9634d8e5924s6zx6",
        sessionID: "main-session",
        messageID: "message-legacy",
        type: "text",
        text: "prompt",
      },
    ];
    const legacyBefore = structuredClone(legacyParts);
    expect(() =>
      insertSyntheticTextPart(legacyParts, "context", "sessionStart"),
    ).toThrow("no ordinary OpenCode part with a persisted identity");
    expect(legacyParts).toEqual(legacyBefore);
  });

  it("uses an ordinary attachment as the identity source", () => {
    const attachment: ChatMessagePart = {
      id: "prt_000000000010abcdefghijklmn",
      sessionID: "attachment-session",
      messageID: "attachment-message",
      type: "file",
      mime: "application/pdf",
      filename: "report.pdf",
    };
    const parts = [structuredClone(attachment)];

    const inserted = insertSyntheticTextPart(
      parts,
      "workflow context",
      "workflowState",
    );

    expect(inserted).toMatchObject({
      sessionID: "attachment-session",
      messageID: "attachment-message",
      synthetic: true,
    });
    expect(parts[1]).toEqual(attachment);
    expect(findUserTextPart(parts)).toBeUndefined();
  });

  it("uses the minimum-ordinal ordinary part as the identity source when a message has both a text and a file part", () => {
    // Real ID shapes from a live OpenCode DB: same millisecond, adjacent
    // counters. The text part (…c001) must win over the file part (…c002).
    const textPart: ChatMessagePart = {
      id: "prt_b9634c88c001aaaaaaaaaaaaaa",
      sessionID: "main-session",
      messageID: "message-multi-part",
      type: "text",
      text: "typed message",
    };
    const filePart: ChatMessagePart = {
      id: "prt_b9634c88c002aaaaaaaaaaaaaa",
      sessionID: "main-session",
      messageID: "message-multi-part",
      type: "file",
      mime: "application/pdf",
      filename: "report.pdf",
    };
    const parts = [structuredClone(textPart), structuredClone(filePart)];

    const sessionStartPart = insertSyntheticTextPart(
      parts,
      "session context",
      "sessionStart",
    );
    const workflowStatePart = insertSyntheticTextPart(
      parts,
      "workflow context",
      "workflowState",
    );

    for (const ordinary of [textPart, filePart]) {
      expect(sessionStartPart.id < ordinary.id).toBe(true);
      expect(workflowStatePart.id < ordinary.id).toBe(true);
    }

    // The sort-below assertions above are necessary but NOT sufficient with
    // this exact fixture: they still pass even if findIdentitySourcePart
    // picks the file part (the *maximum*-ordinal ordinary part) instead of
    // the text part, because the wrongly-sourced workflowState ordinal then
    // collides with the text part's own 12-hex ordinal, and the numeric
    // slot digit "1" still sorts below the "a" tail character by ASCII
    // luck. Pin the exact ordinal derived from the text part (the minimum)
    // so an inverted comparator is actually caught:
    // sessionStart = 0xb9634c88c001 - 2 = 0xb9634c88bfff,
    // workflowState = 0xb9634c88c001 - 1 = 0xb9634c88c000.
    expect(sessionStartPart.id.slice(0, 17)).toBe("prt_b9634c88bfff0");
    expect(workflowStatePart.id.slice(0, 17)).toBe("prt_b9634c88c0001");
  });
});

function setupTrellisProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "phronia-opencode-264-"));
  const taskDir = join(dir, ".phronia", "tasks", "demo-task");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(dir, ".phronia", ".runtime", "sessions"), { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# Demo PRD\n\nGoal: verify injection.");
  writeFileSync(join(taskDir, "implement.jsonl"), "");
  writeFileSync(join(taskDir, "check.jsonl"), "");
  writeFileSync(
    join(dir, ".phronia", "workflow.md"),
    [
      "# Workflow",
      "",
      "[workflow-state:in_progress]",
      "Active task: <task path>. Dispatch phronia-implement or phronia-check.",
      "[/workflow-state:in_progress]",
      "",
    ].join("\n"),
  );
  return dir;
}

function writeSessionFile(dir: string, key: string, taskRef: string): void {
  const file = join(dir, ".phronia", ".runtime", "sessions", `${key}.json`);
  writeFileSync(file, JSON.stringify({ current_task: taskRef }, null, 2));
}

describe("opencode subagent helper", () => {
  it("isTrellisSubagent matches the three trellis sub-agent names", () => {
    expect(isTrellisSubagent({ agent: "phronia-implement" })).toBe(true);
    expect(isTrellisSubagent({ agent: "phronia-check" })).toBe(true);
    expect(isTrellisSubagent({ agent: "phronia-research" })).toBe(true);
  });

  it("isTrellisSubagent rejects unrelated agents", () => {
    expect(isTrellisSubagent({ agent: "build" })).toBe(false);
    expect(isTrellisSubagent({ agent: "phronia-implement-extra" })).toBe(false);
    expect(isTrellisSubagent({ agent: undefined })).toBe(false);
    expect(isTrellisSubagent({})).toBe(false);
    expect(isTrellisSubagent(null)).toBe(false);
  });
});

describe("opencode inject-subagent-context (issue #264)", () => {
  let dir: string;
  let hooks: TaskToolHooks;

  beforeEach(async () => {
    dir = setupTrellisProject();
    hooks = (await injectSubagentContextPlugin({
      directory: dir,
      platform: "linux",
      env: {},
    })) as TaskToolHooks;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mutates implement prompt using single-session fallback when sessionID misses", async () => {
    writeSessionFile(dir, "opencode_sole", ".phronia/tasks/demo-task");
    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-implement",
        prompt: "do the implementation",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );

    expect(output.args.prompt).toContain("<!-- phronia-hook-injected -->");
    expect(output.args.prompt).toContain("# Implement Agent Task");
    expect(output.args.prompt).toContain("Demo PRD");
    expect(output.args.prompt).toContain("do the implementation");
    // Marker must be at the top so generated agent definitions can detect
    // successful injection via a prefix check.
    expect(output.args.prompt.startsWith("<!-- phronia-hook-injected -->")).toBe(
      true,
    );
  });

  it("inlines JSONL-referenced spec content into the implement prompt", async () => {
    // Cover AC #1: "JSONL-referenced context" — the seed-only jsonl path
    // is exercised above; this one verifies a curated entry is inlined.
    const specPath = join(dir, ".phronia", "spec", "demo.md");
    mkdirSync(join(dir, ".phronia", "spec"), { recursive: true });
    writeFileSync(specPath, "# Demo Spec\n\nUNIQUE_SPEC_MARKER_42");
    writeFileSync(
      join(dir, ".phronia", "tasks", "demo-task", "implement.jsonl"),
      JSON.stringify({ file: ".phronia/spec/demo.md", reason: "test" }) + "\n",
    );
    writeSessionFile(dir, "opencode_sole", ".phronia/tasks/demo-task");

    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-implement",
        prompt: "do the implementation",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );

    expect(output.args.prompt).toContain("<!-- phronia-hook-injected -->");
    expect(output.args.prompt).toContain("=== .phronia/spec/demo.md ===");
    expect(output.args.prompt).toContain("UNIQUE_SPEC_MARKER_42");
    expect(output.args.prompt).toContain("Demo PRD");
  });

  it("mutates check prompt using Active task hint when runtime resolution fails", async () => {
    // No session file → both session lookup and single-session fallback miss.
    // Hint is the only resolver.
    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-check",
        prompt: "Active task: .phronia/tasks/demo-task\n\nplease check",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );

    expect(output.args.prompt).toContain("<!-- phronia-hook-injected -->");
    expect(output.args.prompt).toContain("# Check Agent Task");
    expect(output.args.prompt).toContain("Demo PRD");
  });

  it("Active task hint takes precedence over single-session fallback", async () => {
    // Set up TWO matches: a session file pointing at demo-task AND a hint
    // pointing at a different task path. Hint should win.
    writeSessionFile(dir, "opencode_sole", ".phronia/tasks/another-task");
    const hintTask = join(dir, ".phronia", "tasks", "hint-task");
    mkdirSync(hintTask, { recursive: true });
    writeFileSync(join(hintTask, "prd.md"), "# Hint PRD\n\nfrom hint");
    writeFileSync(join(hintTask, "implement.jsonl"), "");

    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-implement",
        prompt: "Active task: .phronia/tasks/hint-task\n\ngo",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );

    expect(output.args.prompt).toContain("Hint PRD");
    expect(output.args.prompt).not.toContain("Demo PRD");
  });

  it("emits the core research prompt without the role-hook marker", async () => {
    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-research",
        prompt: "investigate something",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );

    // Research is a documentation role; Python's hook never marks it, and
    // B3 converged OpenCode on that output.
    expect(output.args.prompt).not.toContain("<!-- phronia-hook-injected -->");
    expect(output.args.prompt).toContain("# Research Agent Task");
  });

  it("skips when no task can be resolved through any path", async () => {
    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-implement",
        prompt: "implement without context",
      },
    };

    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );

    // Prompt is left untouched when implement/check can't find a task
    expect(output.args.prompt).toBe("implement without context");
  });
});

describe("opencode messages.transform injection (issue #553)", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTrellisProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function loadSessionHooks(): Promise<TransformHooks> {
    return (await sessionStartPlugin({ directory: dir })) as TransformHooks;
  }

  async function loadWorkflowHooks(): Promise<TransformHooks> {
    return (await injectWorkflowStatePlugin({
      directory: dir,
    })) as TransformHooks;
  }

  function ephemeralTexts(message: TransformMessage): string[] {
    return message.parts
      .filter(part => part.synthetic === true && typeof part.text === "string")
      .map(part => part.text as string);
  }

  it("injects both plugins onto the latest user message without mutating history", async () => {
    for (const order of [
      ["sessionStart", "workflowState"],
      ["workflowState", "sessionStart"],
    ]) {
      const earlier = userTurn("old prompt", {
        sessionID: "main-session",
        messageID: "message-old",
      });
      const ordinary = createUserTextPart(
        "ordinary user prompt",
        "main-session",
        "message-new",
      );
      ordinary.metadata = { user: { preserved: true } };
      const latest: TransformMessage = {
        info: { role: "user", sessionID: "main-session", agent: "build" },
        parts: [structuredClone(ordinary)],
      };
      const originalEarlierParts = earlier.parts;
      const originalLatestParts = latest.parts;
      const messages: TransformMessage[] = [
        earlier,
        { info: { role: "assistant", sessionID: "main-session" }, parts: [] },
        latest,
      ];
      const sessionHooks = await loadSessionHooks();
      const workflowHooks = await loadWorkflowHooks();

      for (const kind of order) {
        const hooks = kind === "sessionStart" ? sessionHooks : workflowHooks;
        await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
      }

      expect(messages[0]).toBe(earlier);
      expect(messages[0].parts).toBe(originalEarlierParts);
      expect(originalLatestParts).toEqual([ordinary]);
      expect(messages[2]).not.toBe(latest);
      const texts = ephemeralTexts(messages[2]);
      expect(texts.some(text => text.startsWith("<session-context>"))).toBe(
        true,
      );
      expect(texts.some(text => text.startsWith("<workflow-state>"))).toBe(
        true,
      );
      expect(messages[2].parts.at(-1)).toEqual(ordinary);
    }
  }, 30_000);

  it("prepends ephemeral text onto attachment-only latest user messages", async () => {
    const attachment: ChatMessagePart = {
      id: "prt_000000000010abcdefghijklmn",
      sessionID: "main-session",
      messageID: "attachment-only-message",
      type: "file",
      mime: "application/pdf",
      filename: "report.pdf",
    };
    const latest: TransformMessage = {
      info: { role: "user", sessionID: "main-session", agent: "build" },
      parts: [structuredClone(attachment)],
    };
    const originalParts = latest.parts;
    const messages = [latest];
    const sessionHooks = await loadSessionHooks();
    const workflowHooks = await loadWorkflowHooks();
    await workflowHooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    await sessionHooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });

    expect(originalParts).toEqual([attachment]);
    const texts = ephemeralTexts(messages[0]);
    expect(texts.some(text => text.startsWith("<session-context>"))).toBe(true);
    expect(texts.some(text => text.startsWith("<workflow-state>"))).toBe(true);
    expect(messages[0].parts.at(-1)).toEqual(attachment);
  });

  it("injects without a persisted part identity", async () => {
    const sessionHooks = await loadSessionHooks();
    const workflowHooks = await loadWorkflowHooks();
    const latest: TransformMessage = {
      info: { role: "user", sessionID: "main-session", agent: "build" },
      parts: [{ type: "text", text: "original" }],
    };
    const originalParts = latest.parts;
    const messages = [latest];
    await sessionHooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    await workflowHooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(originalParts).toEqual([{ type: "text", text: "original" }]);
    expect(ephemeralTexts(messages[0]).length).toBe(2);
    expect(messages[0].parts.at(-1)).toEqual({ type: "text", text: "original" });
  });

  it("checks the skip keyword only in ordinary user text", async () => {
    const hooks = await loadWorkflowHooks();
    const ordinary = createUserTextPart("ordinary prompt");
    const latest: TransformMessage = {
      info: { role: "user", sessionID: "main-session", agent: "build" },
      parts: [
        {
          type: "text",
          text: "machine context containing no-trellis",
          synthetic: true,
        },
        structuredClone(ordinary),
      ],
    };
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(ephemeralTexts(messages[0]).some(text =>
      text.startsWith("<workflow-state>"),
    )).toBe(true);
    expect(messages[0].parts.at(-1)).toEqual(ordinary);
  });

  it("keeps both plugins disabled by their existing environment gates", async () => {
    const sessionHooks = await loadSessionHooks();
    const workflowHooks = await loadWorkflowHooks();
    const cases = [
      ["PHRONIA_HOOKS", "0"],
      ["PHRONIA_DISABLE_HOOKS", "1"],
      ["OPENCODE_NON_INTERACTIVE", "1"],
    ] as const;

    for (const [key, value] of cases) {
      const previous = process.env[key];
      process.env[key] = value;
      try {
        for (const hooks of [sessionHooks, workflowHooks]) {
          const latest = userTurn("original");
          const original = latest.parts;
          const messages = [latest];
          await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
          expect(messages[0]).toBe(latest);
          expect(messages[0].parts).toBe(original);
        }
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = previous;
      }
    }
  });

  it("session-start.js early-returns when the latest user agent is a trellis sub-agent", async () => {
    const hooks = await loadSessionHooks();
    const latest = userTurn("original", { agent: "phronia-implement" });
    const original = latest.parts;
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(messages[0]).toBe(latest);
    expect(messages[0].parts).toBe(original);
  });

  it("session-start.js skips phronia-check and phronia-research", async () => {
    const hooks = await loadSessionHooks();
    for (const agent of ["phronia-check", "phronia-research"]) {
      const latest = userTurn("untouched", { agent });
      const messages = [latest];
      await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
      expect(messages[0].parts[0].text).toBe("untouched");
    }
  });

  it("inject-workflow-state.js early-returns when the latest user agent is a trellis sub-agent", async () => {
    const hooks = await loadWorkflowHooks();
    const latest = userTurn("original", { agent: "phronia-implement" });
    const original = latest.parts;
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(messages[0]).toBe(latest);
    expect(messages[0].parts).toBe(original);
  });

  it("inject-workflow-state.js still injects breadcrumb for main-session turns", async () => {
    const hooks = await loadWorkflowHooks();
    const latest = userTurn("user prompt");
    const original = latest.parts[0];
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(messages[0].parts[0].text).toContain("<workflow-state>");
    expect(messages[0].parts[0].synthetic).toBe(true);
    expect(messages[0].parts[1]).toEqual(original);
  });

  it("inject-workflow-state.js skips injection when the prompt contains the default skip keyword", async () => {
    const hooks = await loadWorkflowHooks();
    const latest = userTurn("no-trellis what does this regex do");
    const original = latest.parts;
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(messages[0]).toBe(latest);
    expect(messages[0].parts).toBe(original);
  });

  it("inject-workflow-state.js does not skip on 'no-trellisfoo' (word-boundary negative)", async () => {
    const hooks = await loadWorkflowHooks();
    const latest = userTurn("no-trellisfoo is a strange word");
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(messages[0].parts[0].text).toContain("<workflow-state>");
  });

  it("inject-workflow-state.js honors a custom prompt_injection.skip_keyword", async () => {
    writeFileSync(
      join(dir, ".phronia", "config.yaml"),
      ["prompt_injection:", '  skip_keyword: "off-topic"'].join("\n"),
    );
    const hooks = await loadWorkflowHooks();

    const skipped = userTurn("off-topic question");
    const skippedMessages = [skipped];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages: skippedMessages });
    expect(skippedMessages[0]).toBe(skipped);

    const notSkipped = userTurn("no-trellis question", {
      sessionID: "main-session-2",
      messageID: "message-custom-keyword",
    });
    const notSkippedMessages = [notSkipped];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages: notSkippedMessages });
    expect(notSkippedMessages[0].parts[0].text).toContain("<workflow-state>");
  });

  it("inject-workflow-state.js disables the escape hatch with skip_keyword: \"\"", async () => {
    writeFileSync(
      join(dir, ".phronia", "config.yaml"),
      ["prompt_injection:", '  skip_keyword: ""'].join("\n"),
    );
    const hooks = await loadWorkflowHooks();
    const latest = userTurn("no-trellis question");
    const messages = [latest];
    await hooks[MESSAGES_TRANSFORM_HOOK]({}, { messages });
    expect(messages[0].parts[0].text).toContain("<workflow-state>");
  });
});

describe("opencode ephemeral transform helpers", () => {
  it("clones only the latest user message when prepending text", () => {
    const earlier = userTurn("old");
    const latest = userTurn("new", { messageID: "message-b" });
    const messages = [
      earlier,
      { info: { role: "assistant" }, parts: [] },
      latest,
    ];
    expect(prependEphemeralText(messages, "ephemeral")).toBe(true);
    expect(messages[0]).toBe(earlier);
    expect(messages[2]).not.toBe(latest);
    expect(latest.parts).toHaveLength(1);
    expect(messages[2].parts[0]).toEqual({
      type: "text",
      text: "ephemeral",
      synthetic: true,
    });
    expect(messages[2].parts[1]).toBe(latest.parts[0]);
  });
});

// ---------------------------------------------------------------------------
// Issue #441 — sub-agent context injection limits
// ---------------------------------------------------------------------------

describe("opencode context injection limits (issue #441)", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTrellisProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    writeFileSync(join(dir, ".phronia", "config.yaml"), yaml, "utf-8");
  }

  function writeJsonlEntries(entries: Record<string, string>[]): void {
    writeFileSync(
      join(dir, ".phronia", "tasks", "demo-task", "implement.jsonl"),
      entries.map(e => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );
  }

  async function runImplementHook(): Promise<string> {
    writeSessionFile(dir, "opencode_sole", ".phronia/tasks/demo-task");
    const hooks = (await injectSubagentContextPlugin({
      directory: dir,
      platform: "linux",
      env: {},
    })) as TaskToolHooks;
    const output: TaskToolOutput = {
      args: {
        subagent_type: "phronia-implement",
        prompt: "do the implementation",
      },
    };
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: "stranger" },
      output,
    );
    return output.args.prompt ?? "";
  }

  describe("inject-subagent-context plugin", () => {
    it("inlines under-cap content unchanged with no notices (golden)", async () => {
      writeFileSync(join(dir, "small.md"), "small spec content\n", "utf-8");
      writeJsonlEntries([{ file: "small.md", reason: "r" }]);

      const prompt = await runImplementHook();

      expect(prompt).toContain("=== small.md ===\nsmall spec content");
      expect(prompt).toContain(
        "=== .phronia/tasks/demo-task/prd.md (Requirements) ===\n# Demo PRD",
      );
      expect(prompt).not.toContain("[Phronia: truncated");
      expect(prompt).not.toContain("[Phronia: not inlined");
    });

    it("keeps binary jsonl references as notices even when limits are unlimited", async () => {
      const binary = Buffer.from([
        0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x41, 0x42,
      ]);
      writeFileSync(join(dir, "design.png"), binary);
      writeFileSync(join(dir, "invalid.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
      writeJsonlEntries([
        { file: "design.png", reason: "visual baseline" },
        { file: "invalid.bin", reason: "legacy export" },
      ]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 0",
          "  max_total_bytes: 0",
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Phronia: not inlined (binary file) — design.png (10 bytes): visual baseline]",
      );
      expect(prompt).toContain(
        "[Phronia: not inlined (binary file) — invalid.bin (3 bytes): legacy export]",
      );
      expect(prompt).not.toContain("=== design.png ===");
      expect(prompt).not.toContain("=== invalid.bin ===");
      expect(prompt).not.toContain("\u0000");
      expect(prompt).not.toContain("�");
    });

    it("does not misclassify legitimate multi-byte UTF-8 content as binary", async () => {
      const multiByteContent =
        "emoji: 🎉🚀 cjk: 中文测试 bmp: café naïve\n";
      writeFileSync(join(dir, "multibyte.md"), multiByteContent, "utf-8");
      writeJsonlEntries([{ file: "multibyte.md", reason: "unicode spec" }]);

      const prompt = await runImplementHook();

      expect(prompt).toContain(`=== multibyte.md ===\n${multiByteContent}`);
      expect(prompt).not.toContain("[Phronia: not inlined (binary file)");
    });

    it("classifies a file as binary when binary bytes appear only at the end", async () => {
      const mixed = Buffer.concat([
        Buffer.from("looks like a normal text file up front\n", "utf-8"),
        Buffer.from([0x00, 0xff, 0xfe]),
      ]);
      writeFileSync(join(dir, "mixed.dat"), mixed);
      writeJsonlEntries([{ file: "mixed.dat", reason: "mixed content" }]);

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        `[Phronia: not inlined (binary file) — mixed.dat (${mixed.length} bytes): mixed content]`,
      );
      expect(prompt).not.toContain("=== mixed.dat ===");
    });

    it("truncates an oversized jsonl-referenced file at max_file_bytes with a notice", async () => {
      writeFileSync(join(dir, "big.txt"), "A".repeat(2 * 1024 * 1024), "utf-8");
      writeJsonlEntries([{ file: "big.txt", reason: "big" }]);

      const prompt = await runImplementHook();

      expect(Buffer.byteLength(prompt, "utf-8")).toBeLessThanOrEqual(
        128 * 1024 + 4096, // total cap + slack for the prompt template/notices
      );
      expect(prompt).toContain(
        "[Phronia: truncated at 32768 bytes — read big.txt for the full content]",
      );
    });

    it("never splits a multi-byte UTF-8 sequence at the 32768-byte cut point", async () => {
      // 32767 ASCII bytes + Chinese text: the default cap lands inside the
      // first 3-byte character and must back off, not emit mojibake.
      writeFileSync(
        join(dir, "zh.md"),
        "a".repeat(32767) + "中文内容",
        "utf-8",
      );
      writeJsonlEntries([{ file: "zh.md", reason: "zh" }]);

      const prompt = await runImplementHook();

      expect(prompt).not.toContain("�");
      expect(prompt).toContain(
        "a".repeat(32767) +
          "\n[Phronia: truncated at 32768 bytes — read zh.md for the full content]",
      );
    });

    it("truncates an oversized artifact (prd.md) at max_artifact_bytes", async () => {
      writeFileSync(
        join(dir, ".phronia", "tasks", "demo-task", "prd.md"),
        "P".repeat(100000),
        "utf-8",
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain("P".repeat(65536));
      expect(prompt).not.toContain("P".repeat(65537));
      expect(prompt).toContain(
        "[Phronia: truncated at 65536 bytes — read .phronia/tasks/demo-task/prd.md for the full content]",
      );
    });

    it("degrades to an index line once the total budget is exhausted (3 files)", async () => {
      writeFileSync(join(dir, "f1.txt"), "1".repeat(50), "utf-8");
      writeFileSync(join(dir, "f2.txt"), "2".repeat(50), "utf-8");
      writeFileSync(join(dir, "f3.txt"), "3".repeat(50), "utf-8");
      writeJsonlEntries([
        { file: "f1.txt", reason: "first" },
        { file: "f2.txt", reason: "second" },
        { file: "f3.txt", reason: "third" },
      ]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 0",
          "  max_artifact_bytes: 0",
          "  max_total_bytes: 120", // fits f1 fully, degrades f2/f3
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain("=== f1.txt ===\n" + "1".repeat(50));
      expect(prompt).toContain(
        "[Phronia: not inlined (total context limit reached) — f2.txt (50 bytes): second]",
      );
      expect(prompt).toContain(
        "[Phronia: not inlined (total context limit reached) — f3.txt (50 bytes): third]",
      );
      expect(prompt).not.toContain("=== f2.txt ===");
      expect(prompt).not.toContain("=== f3.txt ===");
    });

    it("honors a max_file_bytes override from .phronia/config.yaml", async () => {
      writeFileSync(join(dir, "ref.md"), "R".repeat(100), "utf-8");
      writeJsonlEntries([{ file: "ref.md", reason: "ref" }]);
      writeConfig(["context_injection:", "  max_file_bytes: 10"].join("\n"));

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Phronia: truncated at 10 bytes — read ref.md for the full content]",
      );
      expect(prompt).not.toContain("R".repeat(11));
    });

    it("max_file_bytes: 0 and max_total_bytes: 0 restore fully unlimited inlining", async () => {
      const bigContent = "Z".repeat(40000); // over the 32768 default file cap
      writeFileSync(join(dir, "big.txt"), bigContent, "utf-8");
      writeJsonlEntries([{ file: "big.txt", reason: "big" }]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 0",
          "  max_total_bytes: 0",
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain("=== big.txt ===\n" + bigContent);
      expect(prompt).not.toContain("[Phronia: truncated");
      expect(prompt).not.toContain("[Phronia: not inlined");
    });

    it("invalid config values fall back to the default cap", async () => {
      writeFileSync(join(dir, "big.txt"), "A".repeat(40000), "utf-8");
      writeJsonlEntries([{ file: "big.txt", reason: "big" }]);
      writeConfig(
        ["context_injection:", "  max_file_bytes: not-a-number"].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Phronia: truncated at 32768 bytes — read big.txt for the full content]",
      );
    });

    it("directory entries respect the per-file cap and only inline .md files", async () => {
      mkdirSync(join(dir, "refdir"), { recursive: true });
      writeFileSync(join(dir, "refdir", "a.md"), "A".repeat(1000), "utf-8");
      writeFileSync(join(dir, "refdir", "b.md"), "B".repeat(1000), "utf-8");
      writeFileSync(join(dir, "refdir", "c.txt"), "IGNORED_TXT_CONTENT", "utf-8");
      writeJsonlEntries([
        { file: "refdir/", type: "directory", reason: "reference dir" },
      ]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 10",
          "  max_total_bytes: 0",
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Phronia: truncated at 10 bytes — read refdir/a.md for the full content]",
      );
      expect(prompt).toContain(
        "[Phronia: truncated at 10 bytes — read refdir/b.md for the full content]",
      );
      expect(prompt).not.toContain("IGNORED_TXT_CONTENT");
    });
  });
});
