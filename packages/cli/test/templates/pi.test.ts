import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { collectPiTemplates } from "../../src/configurators/pi.js";
import {
  getAllAgents,
  getExtensionTemplate,
  getSettingsTemplate,
} from "../../src/templates/pi/index.js";

beforeAll(() => {
  process.env.PHRONIA_CLI_PATH = join(process.cwd(), "dist/cli/index.js");
});

interface AgentConfig {
  model?: string;
  thinking?: string;
  tools?: string[];
  fallbackModels: string[];
}

interface PiRunConfig {
  model?: string;
  thinking?: string;
  tools?: string[];
}

interface ContextInjectionLimits {
  max_file_bytes: number;
  max_artifact_bytes: number;
  max_total_bytes: number;
}

interface RegisteredPiTool {
  execute: (
    id: string,
    input: { agent?: string; prompt?: string },
    signal?: AbortSignal,
    onUpdate?: (result: unknown) => void,
    ctx?: {
      cwd?: string;
      model?: { provider?: string; id?: string };
      sessionManager?: { getSessionId?: () => string };
    },
  ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

interface PiExtensionInternals {
  normalizeAgent: (agent: string | undefined) => string;
  isTrellisAgent: (root: string, agent: string) => boolean;
  parseAgentFM: (content: string) => AgentConfig;
  buildPiArgs: (config: PiRunConfig) => string[];
  splitModelThinking: (
    model?: string,
    fallbackThinking?: string,
  ) => { model?: string; thinking?: string };
  resolveRunCfg: (
    input: { model?: string; thinking?: string },
    agentCfg: AgentConfig,
    inheritedThinking?: string,
    inheritedModel?: string,
  ) => PiRunConfig;
  contextModelRef: (ctx?: {
    model?: { provider?: string; id?: string };
  }) => string | undefined;
  cmdHasTrellisCtx: (cmd: string) => boolean;
  shellQuote: (v: string) => string;
  trellisExtension: (pi: {
    registerTool?: (tool: unknown) => void;
    registerShortcut?: (key: string, opts: unknown) => void;
    getThinkingLevel?: () => string;
    on?: (
      event: string,
      handler: (event: unknown, ctx?: unknown) => unknown,
    ) => void;
  }) => void;
  truncateUtf8: (buf: Buffer, cap: number) => Buffer;
  readContextInjectionLimits: (repoRoot: string) => ContextInjectionLimits;
  buildContextForTest: (
    root: string,
    agent: string,
    key: string | null,
  ) => string;
  servingSessionId: () => string | null;
  currentSessionId: (ctx?: {
    sessionManager?: { getSessionId?: () => string };
  }) => string | null;
  parentSessionIdForChild: (ctx?: {
    sessionManager?: { getSessionId?: () => string };
  }) => string | null;
  buildChildEnv: (
    key?: string | null,
    parentSessionId?: string | null,
  ) => NodeJS.ProcessEnv;
}

type MaxThinkingInternals = Pick<
  PiExtensionInternals,
  "buildPiArgs" | "resolveRunCfg" | "splitModelThinking"
>;

function evaluateExtension<T>(
  source: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): T {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const require = createRequire(import.meta.url);
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const sandboxProcess = Object.create(process) as NodeJS.Process;
  const sandboxEnv = { ...process.env, ...env };
  delete sandboxEnv.PHRONIA_SUBAGENT_CHILD;
  Object.defineProperty(sandboxProcess, "cwd", { value: () => cwd });
  Object.defineProperty(sandboxProcess, "env", { value: sandboxEnv });
  const sandbox = vm.createContext({
    Buffer,
    console,
    exports: moduleObject.exports,
    module: moduleObject,
    process: sandboxProcess,
    require,
  });
  vm.runInContext(compiled, sandbox);
  return moduleObject.exports as T;
}

function loadExtensionInternals(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = {},
): PiExtensionInternals {
  const source = `${getExtensionTemplate()}

export {
  normalizeAgent,
  isTrellisAgent,
  parseAgentFM,
  buildPiArgs,
  splitModelThinking,
  resolveRunCfg,
  contextModelRef,
  cmdHasTrellisCtx,
  shellQuote,
  trellisExtension,
  truncateUtf8,
  readContextInjectionLimits,
  buildContext as buildContextForTest,
  servingSessionId,
  currentSessionId,
  parentSessionIdForChild,
  buildChildEnv,
};
`;
  return evaluateExtension<PiExtensionInternals>(source, cwd, env);
}

function loadMaxThinkingInternals(
  extensionSource: string,
): MaxThinkingInternals {
  const source = `${extensionSource}

export { buildPiArgs, resolveRunCfg, splitModelThinking };
`;
  return evaluateExtension<MaxThinkingInternals>(
    source,
    process.cwd(),
    {},
  );
}

function createMinimalTrellisRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "phronia-pi-355-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(join(root, ".phronia", "scripts"), { recursive: true });
  writeFileSync(
    join(root, ".phronia", "workflow.md"),
    [
      "## Phase Index",
      "Phase 1: Plan",
      "",
      "## Phase 1: Plan",
      "",
      "[workflow-state:no_task]",
      "No active task. First classify the current turn and ask for task-creation consent before creating any Phronia task.",
      "[/workflow-state:no_task]",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".phronia", "scripts", "get_context.py"),
    [
      "#!/usr/bin/env python3",
      "import sys",
      "if '--mode' in sys.argv and 'phase' in sys.argv:",
      "    print('## Phase Index\\nPhase 1: Plan')",
      "else:",
      "    print('SESSION CONTEXT\\nCurrent task: none.')",
      "",
    ].join("\n"),
  );
  return root;
}

describe("pi templates", () => {
  it("provides the three Phronia sub-agent definitions", () => {
    const agents = getAllAgents();
    expect(agents.map((agent) => agent.name).sort()).toEqual([
      "phronia-check",
      "phronia-implement",
      "phronia-research",
    ]);

    for (const agent of agents) {
      expect(agent.content).toContain(`name: ${agent.name}`);
      expect(agent.content).not.toContain("inject-subagent-context.py");
    }
  });

  it("settings no longer list a private skills root — Pi discovers shared .agents/skills/ natively (#447)", () => {
    const settings = JSON.parse(getSettingsTemplate().content) as {
      enableSkillCommands?: boolean;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      packages?: unknown[];
    };

    expect(settings.enableSkillCommands).toBe(true);
    expect(settings.extensions).toEqual(["./extensions/phronia/index.ts"]);
    expect(settings.skills).toBeUndefined();
    expect(settings.prompts).toEqual(["./prompts"]);
    expect(settings.packages).toBeUndefined();
  });

  it("writes shared skills to .agents/skills/, not a private .pi/skills/ root (#447)", () => {
    const templates = collectPiTemplates();

    expect(
      templates.get(".agents/skills/phronia-check/SKILL.md"),
    ).toBeDefined();
    for (const key of templates.keys()) {
      expect(key.startsWith(".pi/skills/")).toBe(false);
    }
  });

  it("collects a manual phronia-start prompt for Pi fallback bootstrap", () => {
    const templates = collectPiTemplates();

    expect(templates.get(".pi/prompts/phronia-start.md")).toContain(
      "# Start Session",
    );
    expect(templates.get(".pi/prompts/phronia-continue.md")).toContain(
      "get_context.py --mode phase",
    );
    expect(templates.get(".pi/prompts/phronia-finish-work.md")).toContain(
      "finish-work",
    );
  });

  it("extension registers the trellis_subagent tool with mode+thinking schema", () => {
    const extension = getExtensionTemplate();

    // Tool name + label avoid collision with community subagent packages.
    expect(extension).toContain('name: "trellis_subagent"');
    expect(extension).toContain('label: "Phronia Subagent"');

    // Schema must declare the three dispatch modes and the thinking enum so the LLM
    // can pick a valid mode and override thinking per call.
    expect(extension).toContain(
      'enum: ["single", "parallel", "chain"]',
    );
    expect(extension).toContain(
      'enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"]',
    );

    // Dispatch protocol carries the "Active task: <path>" prefix rule.
    expect(extension).toContain("Active task:");
  });

  it("extension wires the Pi events Phronia needs for context flow", () => {
    const extension = getExtensionTemplate();

    // session_start: notify-only welcome
    expect(extension).toContain('pi.on?.("session_start"');
    // input: not used; Phronia must not rewrite submitted user text
    expect(extension).not.toContain('pi.on?.("input"');
    // before_agent_start: preserves system prompt context and persists hidden runtime context
    expect(extension).toContain('pi.on?.("before_agent_start"');
    // context: preserves the existing context-key establishment behavior only
    expect(extension).toContain('pi.on?.("context"');
    // tool_call: inject PHRONIA_CONTEXT_ID into bash commands
    expect(extension).toContain('pi.on?.("tool_call"');
    // tool_result: mark failed/cancelled subagent runs as errors
    expect(extension).toContain('pi.on?.("tool_result"');
  });

  it("keeps user input clean while persisting hidden runtime context", () => {
    const root = createMinimalTrellisRoot();
    const { trellisExtension } = loadExtensionInternals(root);
    const handlers = new Map<
      string,
      (event: unknown, ctx?: unknown) => unknown
    >();

    trellisExtension({
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const ctx = {
      sessionManager: { getSessionId: () => "pi-unit-355" },
      ui: { notify: vi.fn() },
    };

    expect(handlers.has("input")).toBe(false);

    const beforeAgentStart = handlers.get("before_agent_start");
    const first = beforeAgentStart?.(
      {
        type: "before_agent_start",
        prompt: "Adjust service routing",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      },
      ctx,
    ) as {
      systemPrompt?: string;
      message: { customType?: string; content?: string; display?: boolean };
    };

    expect(first.systemPrompt).toContain("BASE");
    expect(first.systemPrompt).toContain(
      "Phronia compact SessionStart context",
    );
    expect(first.systemPrompt).toContain("<first-reply-notice>");
    expect(first.systemPrompt).toContain("the user's current request");
    expect(first.systemPrompt).toContain(
      "the user message that triggered this reply",
    );
    expect(first.systemPrompt).toContain("has no clear natural language");
    expect(first.systemPrompt).toContain(
      "explicitly established project communication language",
    );
    expect(first.systemPrompt).toContain("Phronia SessionStart ✓");
    expect(first.systemPrompt).toContain(
      "Continue directly with the user's request",
    );
    expect(first.systemPrompt).toContain(
      "must not alter the language used for the remainder of the response",
    );
    expect(first.systemPrompt).toContain("This notice is one-shot");
    expect(first.systemPrompt).not.toContain("say once in Chinese");
    expect(first.systemPrompt).not.toContain(
      "exactly one short Chinese sentence",
    );
    expect(first.systemPrompt).not.toContain(
      "Phronia SessionStart 已注入：workflow、当前任务状态、开发者身份、git 状态、active tasks、spec 索引已加载。",
    );
    expect(first.systemPrompt).toContain("<phronia-workflow>");
    expect(first.systemPrompt).toContain("Phase 1: Plan");
    expect(first.systemPrompt).toContain("No active Phronia task found");
    expect(first.systemPrompt).not.toContain("<workflow-state>");
    // The system prompt carries startup's session-overview snapshot.
    expect(first.systemPrompt).toContain("<current-state>");
    expect(first.message).toEqual(
      expect.objectContaining({
        customType: "phronia-runtime-context",
        display: false,
      }),
    );
    expect("role" in first.message).toBe(false);
    expect("timestamp" in first.message).toBe(false);
    expect(first.message.content).not.toContain("BASE");
    expect(first.message.content).not.toContain(
      "Phronia compact SessionStart context",
    );
    expect(first.message.content).toContain("<workflow-state>");
    expect(first.message.content).toContain("Status: no_task");
    // The startup snapshot is stable and stays in systemPrompt; only the
    // per-turn workflow breadcrumb travels through the message channel.
    expect(first.message.content).not.toContain("<current-state>");

    const second = beforeAgentStart?.(
      {
        type: "before_agent_start",
        prompt: "Continue",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      },
      ctx,
    ) as {
      systemPrompt?: string;
      message?: { customType?: string; content?: string; display?: boolean };
    };

    // Provider prefix caches invalidate from byte 0 on any systemPrompt
    // change, so later turns must return the exact same bytes as turn one.
    expect(second.systemPrompt).toBe(first.systemPrompt);
    // Unchanged runtime context is not re-sent: the persisted message from
    // turn one is already in the session history.
    expect(second.message).toBeUndefined();
    expect(handlers.has("context")).toBe(true);
  });

  it("delivers task context changes as persisted messages, not systemPrompt churn", () => {
    const root = createMinimalTrellisRoot();
    const { trellisExtension } = loadExtensionInternals(root);
    const handlers = new Map<
      string,
      (event: unknown, ctx?: unknown) => unknown
    >();

    trellisExtension({
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const ctx = {
      sessionManager: { getSessionId: () => "pi-unit-task-update" },
      ui: { notify: vi.fn() },
    };
    const beforeAgentStart = handlers.get("before_agent_start");
    const fire = () =>
      beforeAgentStart?.(
        {
          type: "before_agent_start",
          prompt: "Continue",
          systemPrompt: "BASE",
          systemPromptOptions: {},
        },
        ctx,
      ) as {
        systemPrompt?: string;
        message?: { customType?: string; content?: string; display?: boolean };
      };

    const first = fire();
    expect(first.systemPrompt).toContain("No active Phronia task found");

    // A task is created and activated mid-session.
    const taskDir = join(root, ".phronia", "tasks", "07-07-cache-fix");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD\nStable prefix matters.");
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({ id: "07-07-cache-fix", status: "in_progress" }),
    );
    mkdirSync(join(root, ".phronia", ".runtime", "sessions"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".phronia", ".runtime", "sessions", "pi_pi-unit-task-update.json"),
      JSON.stringify({ current_task: "tasks/07-07-cache-fix" }),
    );

    const second = fire();
    // systemPrompt keeps the turn-one snapshot byte-for-byte...
    expect(second.systemPrompt).toBe(first.systemPrompt);
    // ...and the new task context arrives as a persisted hidden message.
    expect(second.message?.customType).toBe("phronia-runtime-context");
    expect(second.message?.content).toContain("<phronia-task-context-update>");
    expect(second.message?.content).toContain("Stable prefix matters.");

    // No further changes -> nothing new to persist.
    const third = fire();
    expect(third.systemPrompt).toBe(first.systemPrompt);
    expect(third.message).toBeUndefined();
  }, 30000);

  it("keeps a native Pi session isolated from a foreign context key (#512)", () => {
    const root = createMinimalTrellisRoot();
    const taskDir = join(root, ".phronia", "tasks", "foreign-task");
    const sessionsDir = join(root, ".phronia", ".runtime", "sessions");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "FOREIGN TASK CONTENT");
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({ id: "foreign-task", status: "in_progress" }),
    );
    writeFileSync(
      join(sessionsDir, "pi_process_foreign.json"),
      JSON.stringify({ current_task: "tasks/foreign-task" }),
    );

    try {
      const { trellisExtension } = loadExtensionInternals(root, {
        PHRONIA_CONTEXT_ID: "pi_process_foreign",
      });
      const handlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      trellisExtension({
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on(event, handler) {
          handlers.set(event, handler);
        },
      });
      const ctx = {
        sessionManager: {
          sessionId: "native-window-b",
          getSessionId(this: { sessionId: string }) {
            return this.sessionId;
          },
        },
        ui: { notify: vi.fn() },
      };

      handlers.get("session_start")?.({ type: "session_start" }, ctx);
      const bashEvent = {
        toolName: "bash",
        input: { command: "printf safe" },
      };
      handlers.get("tool_call")?.(bashEvent, ctx);
      expect(bashEvent.input.command).toBe(
        "export PHRONIA_CONTEXT_ID='pi_native-window-b'; printf safe",
      );

      const collisionKeys = ["native/window", "native:window"].map(
        (sessionId) => {
          const collisionHandlers = new Map<
            string,
            (event: unknown, ctx?: unknown) => unknown
          >();
          loadExtensionInternals(root).trellisExtension({
            on(event, handler) {
              collisionHandlers.set(event, handler);
            },
          });
          const event = {
            toolName: "bash",
            input: { command: "printf collision" },
          };
          collisionHandlers.get("tool_call")?.(event, {
            sessionManager: { getSessionId: () => sessionId },
          });
          return event.input.command.match(
            /^export PHRONIA_CONTEXT_ID='([^']+)'/,
          )?.[1];
        },
      );
      expect(collisionKeys[0]).toMatch(/^pi_native_window_[a-f0-9]{24}$/);
      expect(collisionKeys[1]).toMatch(/^pi_native_window_[a-f0-9]{24}$/);
      expect(collisionKeys[0]).not.toBe(collisionKeys[1]);

      const beforeAgentStart = handlers.get("before_agent_start")?.(
        { type: "before_agent_start", systemPrompt: "BASE" },
        ctx,
      ) as { systemPrompt?: string; message?: { content?: string } };
      expect(beforeAgentStart.systemPrompt).not.toContain("FOREIGN TASK CONTENT");
      expect(beforeAgentStart.message?.content).not.toContain(
        "FOREIGN TASK CONTENT",
      );

      const fallbackHandlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      loadExtensionInternals(root, {
        PHRONIA_CONTEXT_ID: "pi_process_foreign",
      }).trellisExtension({
        on(event, handler) {
          fallbackHandlers.set(event, handler);
        },
      });
      const firstFallback = {
        toolName: "bash",
        input: { command: "printf one" },
      };
      const secondFallback = {
        toolName: "bash",
        input: { command: "printf two" },
      };
      fallbackHandlers.get("tool_call")?.(firstFallback);
      fallbackHandlers.get("tool_call")?.(secondFallback);
      const fallbackKey = firstFallback.input.command.match(
        /^export PHRONIA_CONTEXT_ID='([^']+)'/,
      )?.[1];
      expect(fallbackKey).toMatch(/^pi_process_[a-f0-9]{24}$/);
      expect(fallbackKey).not.toBe("pi_process_foreign");
      expect(secondFallback.input.command).toContain(
        `PHRONIA_CONTEXT_ID='${fallbackKey}'`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("scopes per-session caches by resolved root when ctx.cwd changes", () => {
    const root1 = createMinimalTrellisRoot();
    const root2 = createMinimalTrellisRoot();
    const sessionsDir1 = join(root1, ".phronia", ".runtime", "sessions");
    const sessionsDir2 = join(root2, ".phronia", ".runtime", "sessions");
    const taskDir1 = join(root1, ".phronia", "tasks", "shared-task");
    const taskDir2 = join(root2, ".phronia", "tasks", "shared-task");
    mkdirSync(sessionsDir1, { recursive: true });
    mkdirSync(sessionsDir2, { recursive: true });
    mkdirSync(taskDir1, { recursive: true });
    mkdirSync(taskDir2, { recursive: true });
    writeFileSync(join(taskDir1, "prd.md"), "ROOT ONE PRD CONTENT");
    writeFileSync(join(taskDir2, "prd.md"), "ROOT TWO PRD CONTENT");
    const sessionRef = JSON.stringify({ current_task: "tasks/shared-task" });
    writeFileSync(join(sessionsDir1, "pi_shared-session.json"), sessionRef);
    writeFileSync(join(sessionsDir2, "pi_shared-session.json"), sessionRef);

    try {
      const { trellisExtension } = loadExtensionInternals();
      const handlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      trellisExtension({
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on(event, handler) {
          handlers.set(event, handler);
        },
      });
      const fire = (cwd: string) =>
        handlers.get("before_agent_start")?.(
          { type: "before_agent_start", systemPrompt: "BASE" },
          { cwd, sessionManager: { getSessionId: () => "shared-session" } },
        ) as { systemPrompt?: string; message?: { content?: string } };

      const first = fire(root1);
      expect(first.systemPrompt).toContain("ROOT ONE PRD CONTENT");

      // Same session key but a different session cwd must NOT reuse the
      // first project's cached startup/task context.
      const second = fire(root2);
      expect(second.systemPrompt).toContain("ROOT TWO PRD CONTENT");
      expect(second.systemPrompt).not.toContain("ROOT ONE PRD CONTENT");
    } finally {
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("re-asserts the current root's task context when a session switches back", () => {
    const root1 = createMinimalTrellisRoot();
    const root2 = createMinimalTrellisRoot();
    const sessionsDir1 = join(root1, ".phronia", ".runtime", "sessions");
    const sessionsDir2 = join(root2, ".phronia", ".runtime", "sessions");
    const taskDir1 = join(root1, ".phronia", "tasks", "shared-task");
    const taskDir2 = join(root2, ".phronia", "tasks", "shared-task");
    mkdirSync(sessionsDir1, { recursive: true });
    mkdirSync(sessionsDir2, { recursive: true });
    mkdirSync(taskDir1, { recursive: true });
    mkdirSync(taskDir2, { recursive: true });
    writeFileSync(join(taskDir1, "prd.md"), "ROOT ONE PRD CONTENT");
    writeFileSync(join(taskDir2, "prd.md"), "ROOT TWO PRD CONTENT");
    const sessionRef = JSON.stringify({ current_task: "tasks/shared-task" });
    writeFileSync(join(sessionsDir1, "pi_shared-session.json"), sessionRef);
    writeFileSync(join(sessionsDir2, "pi_shared-session.json"), sessionRef);

    try {
      const { trellisExtension } = loadExtensionInternals();
      const handlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      trellisExtension({
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on(event, handler) {
          handlers.set(event, handler);
        },
      });
      const fire = (cwd: string) =>
        handlers.get("before_agent_start")?.(
          { type: "before_agent_start", systemPrompt: "BASE" },
          { cwd, sessionManager: { getSessionId: () => "shared-session" } },
        ) as { systemPrompt?: string; message?: { content?: string } };

      // A: first visit seeds the snapshot into the system prompt; the
      // persisted history carries only the runtime context.
      const a1 = fire(root1);
      expect(a1.message?.content ?? "").not.toContain(
        "<phronia-task-context-update>",
      );

      // A -> B: the switch re-asserts B's task context as a persisted
      // update (it supersedes the system-prompt context).
      const b = fire(root2);
      expect(b.message?.content).toContain("<phronia-task-context-update>");
      expect(b.message?.content).toContain("ROOT TWO PRD CONTENT");

      // B -> A with unchanged A on disk: A's task context must be re-emitted
      // so the most recent persisted update belongs to A, not B.
      const a2 = fire(root1);
      expect(a2.message?.content).toContain("<phronia-task-context-update>");
      expect(a2.message?.content).toContain("ROOT ONE PRD CONTENT");
      expect(a2.message?.content).not.toContain("ROOT TWO PRD CONTENT");
    } finally {
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  }, 30000);

  it("extension tool_result handler marks failed/cancelled subagent runs as errors", () => {
    const extension = getExtensionTemplate();

    expect(extension).toContain('ev.toolName === "trellis_subagent"');
    expect(extension).toContain('r.status === "failed"');
    expect(extension).toContain('r.status === "cancelled"');
    expect(extension).toContain("isError: true");
  });

  it("normalizeAgent prefixes bare names with phronia- and leaves prefixed names alone", () => {
    const { normalizeAgent } = loadExtensionInternals();

    expect(normalizeAgent("implement")).toBe("phronia-implement");
    expect(normalizeAgent("check")).toBe("phronia-check");
    expect(normalizeAgent("phronia-research")).toBe("phronia-research");
    expect(normalizeAgent(undefined)).toBe("phronia-implement");
    expect(normalizeAgent("phronia-custom")).toBe("phronia-custom");
  });

  it("isTrellisAgent gates on a real .pi/agents/*.md definition file", () => {
    const { isTrellisAgent } = loadExtensionInternals();

    const root = mkdtempSync(join(tmpdir(), "phronia-pi-test-"));
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "agents", "phronia-implement.md"),
      "---\nname: phronia-implement\n---\n",
    );

    expect(isTrellisAgent(root, "phronia-implement")).toBe(true);
    expect(isTrellisAgent(root, "phronia-foo")).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("parseAgentFM reads model/thinking/fallbackModels/tools from agent frontmatter", () => {
    const { parseAgentFM } = loadExtensionInternals();

    // Mixed-case tool names in frontmatter must be normalized to lowercase:
    // Pi's built-in tools are lowercase (read, bash, edit, write, grep, find, ls)
    // and pi applies the allowlist without case normalization, so uppercase names
    // would silently fail to enable any tool.
    const cfg = parseAgentFM(`---
name: reviewer
model: anthropic/claude-sonnet-4
thinking: high
tools: Read, Write, Bash, find, Grep
fallbackModels:
  - openai/gpt-5-mini
  - "google/gemini-2.5-pro"
---
# Reviewer
`);

    expect(cfg).toEqual({
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
      tools: ["read", "write", "bash", "find", "grep"],
      fallbackModels: ["openai/gpt-5-mini", "google/gemini-2.5-pro"],
    });
    // Belt-and-suspenders: no tool name survives with uppercase letters.
    expect(cfg.tools?.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("buildPiArgs maps PiRunConfig onto Pi CLI args", () => {
    const { buildPiArgs } = loadExtensionInternals();

    // model + thinking → composes "model:thinking" suffix when not already present
    expect(buildPiArgs({ model: "anthropic/claude-sonnet-4", thinking: "high" })).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "anthropic/claude-sonnet-4:high",
    ]);

    // model already has thinking suffix → passed through unchanged
    expect(
      buildPiArgs({ model: "anthropic/claude-sonnet-4:low", thinking: "high" }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "anthropic/claude-sonnet-4:low",
    ]);

    // thinking-only (no model) → standalone --thinking flag
    expect(buildPiArgs({ thinking: "minimal" })).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--thinking",
      "minimal",
    ]);

    // thinking=off is suppressed
    expect(buildPiArgs({ model: "gpt-5", thinking: "off" })).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "gpt-5",
    ]);

    // tools → --tools flag
    expect(
      buildPiArgs({ tools: ["Read", "Write", "Bash", "find", "Grep"] }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--tools",
      "Read,Write,Bash,find,Grep",
    ]);
  });

  it("supports max thinking for GPT-5.6 subagents (#470)", () => {
    const agentCfg: AgentConfig = {
      model: "openai/gpt-5.6-sol",
      thinking: "max",
      fallbackModels: [],
    };
    const dogfoodExtension = readFileSync(
      join(process.cwd(), "..", "..", ".pi", "extensions", "phronia", "index.ts"),
      "utf-8",
    );

    for (const extensionSource of [getExtensionTemplate(), dogfoodExtension]) {
      const { buildPiArgs, resolveRunCfg, splitModelThinking } =
        loadMaxThinkingInternals(extensionSource);
      const config = resolveRunCfg({}, agentCfg);

      expect(config).toEqual({
        model: "openai/gpt-5.6-sol:max",
        thinking: "max",
      });
      expect(buildPiArgs(config)).toEqual([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        "openai/gpt-5.6-sol:max",
      ]);
      expect(splitModelThinking(config.model)).toEqual({
        model: "openai/gpt-5.6-sol",
        thinking: "max",
      });
    }
  });

  it("inherits the invoking Pi model after per-call and agent defaults", () => {
    const { buildPiArgs, contextModelRef, resolveRunCfg } =
      loadExtensionInternals();

    const agentCfg: AgentConfig = {
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
      tools: ["Read", "Write", "Edit", "Bash", "find", "Grep"],
      fallbackModels: [],
    };

    // Per-call model + thinking win over agent config
    expect(
      resolveRunCfg(
        { model: "openai/gpt-5", thinking: "xhigh" },
        agentCfg,
        "medium",
        "google/gemini-2.5-pro",
      ),
    ).toEqual({
      model: "openai/gpt-5:xhigh",
      thinking: "xhigh",
      tools: agentCfg.tools,
    });

    // Agent config wins over the invoking session model.
    expect(
      resolveRunCfg({}, agentCfg, "medium", "google/gemini-2.5-pro"),
    ).toEqual({
      model: "anthropic/claude-sonnet-4:high",
      thinking: "high",
      tools: agentCfg.tools,
    });

    // With no stronger model, use the provider-qualified invoking session model.
    const inheritedModel = contextModelRef({
      model: { provider: "openai-proxy", id: "gpt-5.6-sol" },
    });
    const inheritedCfg = resolveRunCfg(
      {},
      { fallbackModels: [] },
      "xhigh",
      inheritedModel,
    );
    expect(inheritedCfg).toEqual({
      model: "openai-proxy/gpt-5.6-sol:xhigh",
      thinking: "xhigh",
    });
    expect(buildPiArgs(inheritedCfg)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "openai-proxy/gpt-5.6-sol:xhigh",
    ]);

    // Incomplete context preserves the previous no-model behavior.
    expect(contextModelRef()).toBeUndefined();
    expect(contextModelRef({ model: { id: "gpt-5.6-sol" } })).toBeUndefined();
  });

  it("passes the invoking Pi model to the spawned child process", async () => {
    const hostRoot = createMinimalTrellisRoot();
    const sessionRoot = createMinimalTrellisRoot();
    const agentDir = join(sessionRoot, ".pi", "agents");
    const fakeCli = join(sessionRoot, "fake-pi.cjs");
    const capturedArgs = join(sessionRoot, "child-args.json");
    const capturedCwd = join(sessionRoot, "child-cwd.txt");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "phronia-implement.md"),
      "---\nname: phronia-implement\n---\nImplement the task.\n",
    );
    writeFileSync(
      fakeCli,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(capturedArgs)}, JSON.stringify(process.argv.slice(2)));`,
        `writeFileSync(${JSON.stringify(capturedCwd)}, process.cwd());`,
        'process.stdout.write(JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "fake child ok" }] } }) + "\\n");',
        "",
      ].join("\n"),
    );

    try {
      const { trellisExtension } = loadExtensionInternals(hostRoot, {
        PHRONIA_PI_CLI_JS: fakeCli,
      });
      let registeredTool: RegisteredPiTool | undefined;
      trellisExtension({
        registerTool(tool) {
          registeredTool = tool as RegisteredPiTool;
        },
        getThinkingLevel: () => "xhigh",
      });
      expect(registeredTool).toBeDefined();
      if (!registeredTool)
        throw new Error("trellis_subagent was not registered");

      const result = await registeredTool.execute(
        "model-inheritance-test",
        { agent: "phronia-implement", prompt: "Implement the task" },
        undefined,
        undefined,
        {
          cwd: sessionRoot,
          model: { provider: "openai-proxy", id: "gpt-5.6-sol" },
        },
      );

      expect(result.content[0]?.text).toBe("fake child ok");
      expect(realpathSync(readFileSync(capturedCwd, "utf-8"))).toBe(
        realpathSync(sessionRoot),
      );
      expect(JSON.parse(readFileSync(capturedArgs, "utf-8"))).toEqual([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        "openai-proxy/gpt-5.6-sol:xhigh",
      ]);
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("cmdHasTrellisCtx detects already-prefixed bash commands", () => {
    const { cmdHasTrellisCtx } = loadExtensionInternals();

    expect(cmdHasTrellisCtx("export PHRONIA_CONTEXT_ID=foo; ls")).toBe(true);
    expect(cmdHasTrellisCtx("PHRONIA_CONTEXT_ID=foo ls")).toBe(true);
    expect(cmdHasTrellisCtx("env PHRONIA_CONTEXT_ID=foo ls")).toBe(true);
    expect(cmdHasTrellisCtx("ls -la")).toBe(false);
    expect(cmdHasTrellisCtx("")).toBe(false);
  });

  describe("permission-forwarding parent session (#610)", () => {
  function writeHeartbeat(
    sessionDir: string,
    sessionId: string,
    pid: number,
    updatedAt: number,
    fileName?: string,
  ): void {
    const dir = join(sessionDir, "permission-forwarding", "serving");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, fileName ?? `${encodeURIComponent(sessionId)}.json`),
      JSON.stringify({ sessionId, pid, updatedAt }),
    );
  }

  it("prefers the serving heartbeat id over a live ctx id and stale PI_SESSION_ID", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "phronia-pi-610-serving-"));
    writeHeartbeat(sessionDir, "serving-session", process.pid, 200);
    writeHeartbeat(sessionDir, "older-serving", process.pid, 100, "older.json");
    writeHeartbeat(sessionDir, "other-process", process.pid + 1, 999);

    try {
      const { servingSessionId, parentSessionIdForChild, currentSessionId } =
        loadExtensionInternals(process.cwd(), {
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
          PI_SESSION_ID: "stale-env-id",
        });

      expect(servingSessionId()).toBe("serving-session");
      expect(
        currentSessionId({
          sessionManager: { getSessionId: () => "live-forked-id" },
        }),
      ).toBe("live-forked-id");
      expect(
        parentSessionIdForChild({
          sessionManager: { getSessionId: () => "live-forked-id" },
        }),
      ).toBe("serving-session");
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("falls back to ctx then env when no serving heartbeat exists", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "phronia-pi-610-fallback-"));

    try {
      const withCtx = loadExtensionInternals(process.cwd(), {
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        PI_SESSION_ID: "stale-env-id",
      });
      expect(
        withCtx.parentSessionIdForChild({
          sessionManager: { getSessionId: () => "ctx-session" },
        }),
      ).toBe("ctx-session");

      const envOnly = loadExtensionInternals(process.cwd(), {
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        PI_SESSION_ID: "stale-env-id",
      });
      expect(envOnly.parentSessionIdForChild()).toBe("stale-env-id");
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("strips inherited PI_SESSION_ID and always marks the child as a subagent", () => {
    const { buildChildEnv } = loadExtensionInternals(process.cwd(), {
      PI_SESSION_ID: "parent-session",
      PI_SESSIONID: "parent-session-alt",
      PATH: "/usr/bin",
    });

    const withParent = buildChildEnv("pi_ctx", "serving-session");
    expect(withParent.PHRONIA_SUBAGENT_CHILD).toBe("1");
    expect(withParent.PI_SUBAGENT_CHILD).toBe("1");
    expect(withParent.PHRONIA_CONTEXT_ID).toBe("pi_ctx");
    expect(withParent.PI_SUBAGENT_PARENT_SESSION).toBe("serving-session");
    expect(withParent.PI_SESSION_ID).toBeUndefined();
    expect(withParent.PI_SESSIONID).toBeUndefined();

    const noParent = buildChildEnv(null, null);
    expect(noParent.PI_SUBAGENT_CHILD).toBe("1");
    expect(noParent.PI_SUBAGENT_PARENT_SESSION).toBeUndefined();
    expect(noParent.PHRONIA_CONTEXT_ID).toBeUndefined();
  });

  it("injects serving parent env into the spawned headless pi process", async () => {
    const hostRoot = createMinimalTrellisRoot();
    const sessionRoot = createMinimalTrellisRoot();
    const sessionDir = mkdtempSync(join(tmpdir(), "phronia-pi-610-spawn-"));
    const agentDir = join(sessionRoot, ".pi", "agents");
    const fakeCli = join(sessionRoot, "fake-pi.cjs");
    const capturedEnv = join(sessionRoot, "child-env.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "phronia-implement.md"),
      "---\nname: phronia-implement\n---\nImplement the task.\n",
    );
    writeHeartbeat(sessionDir, "serving-heartbeat-id", process.pid, Date.now());
    writeFileSync(
      fakeCli,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(capturedEnv)}, JSON.stringify({`,
        "  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,",
        "  PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,",
        "  PHRONIA_SUBAGENT_CHILD: process.env.PHRONIA_SUBAGENT_CHILD,",
        "  PI_SESSION_ID: process.env.PI_SESSION_ID ?? null,",
        "  PI_SESSIONID: process.env.PI_SESSIONID ?? null,",
        "}));",
        'process.stdout.write(JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "fake child ok" }] } }) + "\\n");',
        "",
      ].join("\n"),
    );

    try {
      const { trellisExtension } = loadExtensionInternals(hostRoot, {
        PHRONIA_PI_CLI_JS: fakeCli,
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        PI_SESSION_ID: "stale-parent-id",
      });
      let registeredTool: RegisteredPiTool | undefined;
      trellisExtension({
        registerTool(tool) {
          registeredTool = tool as RegisteredPiTool;
        },
        getThinkingLevel: () => "low",
      });
      expect(registeredTool).toBeDefined();
      if (!registeredTool)
        throw new Error("trellis_subagent was not registered");

      const result = await registeredTool.execute(
        "permission-forward-test",
        { agent: "phronia-implement", prompt: "Implement the task" },
        undefined,
        undefined,
        {
          cwd: sessionRoot,
          sessionManager: { getSessionId: () => "live-forked-id" },
        },
      );

      expect(result.content[0]?.text).toBe("fake child ok");
      expect(JSON.parse(readFileSync(capturedEnv, "utf-8"))).toEqual({
        PI_SUBAGENT_CHILD: "1",
        PI_SUBAGENT_PARENT_SESSION: "serving-heartbeat-id",
        PHRONIA_SUBAGENT_CHILD: "1",
        PI_SESSION_ID: null,
        PI_SESSIONID: null,
      });
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

  it("shellQuote single-quotes values and escapes embedded single quotes", () => {
    const { shellQuote } = loadExtensionInternals();

    expect(shellQuote("simple")).toBe("'simple'");
    expect(shellQuote("with space")).toBe("'with space'");
    expect(shellQuote("with 'quote'")).toBe("'with '\\''quote'\\'''");
  });

  it("extension forwards PHRONIA_CONTEXT_ID into spawned Pi child env", () => {
    const extension = getExtensionTemplate();

    // The child pi process must inherit PHRONIA_CONTEXT_ID so sub-agent
    // task.py current resolves to the same task.
    expect(extension).toContain("PHRONIA_CONTEXT_ID:");
    expect(extension).toContain("...process.env");
  });

  it("forwards permission asks to the serving parent session (#610)", () => {
    const dogfoodExtension = readFileSync(
      join(process.cwd(), "..", "..", ".pi", "extensions", "phronia", "index.ts"),
      "utf-8",
    );

    for (const extension of [getExtensionTemplate(), dogfoodExtension]) {
      expect(extension).toContain("PI_SUBAGENT_PARENT_SESSION");
      expect(extension).toContain('PI_SUBAGENT_CHILD: "1"');
      expect(extension).toContain("delete childEnv.PI_SESSION_ID");
      expect(extension).toContain("delete childEnv.PI_SESSIONID");
      expect(extension).toContain("permission-forwarding");
      expect(extension).toContain("servingSessionId()");
    }
  });

  it("extension validates agent definition before spawning a child pi process", () => {
    const extension = getExtensionTemplate();

    // Non-Phronia agent calls must short-circuit and point users to community
    // subagent packages instead of silently spawning a child pi process with
    // a missing agent definition.
    expect(extension).toContain("isTrellisAgent(root, agentName)");
    expect(extension).toContain("npm:@tintinweb/pi-subagents");
    expect(extension).toContain("npm:pi-subagents");
  });
});
