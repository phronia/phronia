import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import {
  getAllAgents,
  getExtensionTemplate,
} from "../../src/templates/omp/index.js";
import { collectOmpTemplates } from "../../src/configurators/omp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(__dirname, "../../src/templates/omp");

beforeAll(() => {
  process.env.PHRONIA_CLI_PATH = path.join(process.cwd(), "dist/cli/index.js");
});

type OmpEventHandler = (event: unknown, ctx?: unknown) => unknown;
type OmpExtension = (pi: {
  on: (event: string, handler: OmpEventHandler) => void;
  sendMessage?: (message: unknown) => Promise<void>;
}) => void;

function loadOmpExtension(): OmpExtension {
  const compiled = ts.transpileModule(getExtensionTemplate(), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const require = createRequire(import.meta.url);
  const moduleObject: { exports: { default?: OmpExtension } } = { exports: {} };
  const sandboxProcess = Object.create(process) as NodeJS.Process;
  const sandboxEnv = { ...process.env };
  delete sandboxEnv.PHRONIA_CONTEXT_ID;
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
  const extension = moduleObject.exports.default;
  if (!extension) throw new Error("OMP extension template has no default export");
  return extension;
}

function captureOmpHandlers(): Map<string, OmpEventHandler> {
  const handlers = new Map<string, OmpEventHandler>();
  loadOmpExtension()({
    on: (event, handler) => handlers.set(event, handler),
  });
  return handlers;
}

function makeOmpProject(): { root: string; taskDir: string; sessionId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-omp-"));
  const taskDir = path.join(root, ".phronia", "tasks", "08-13-context-limits");
  const sessionId = "context_limits";
  fs.mkdirSync(path.join(root, ".phronia", ".runtime", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, ".phronia", "spec", "guides"), { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, ".phronia", "workflow.md"), "## Phase Index\nPhase 1: Plan\n");
  fs.writeFileSync(path.join(root, ".phronia", "spec", "guides", "index.md"), "# guides");
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ status: "in_progress", title: "Context limits" }));
  fs.writeFileSync(path.join(taskDir, "prd.md"), "# PRD body");
  fs.writeFileSync(
    path.join(taskDir, "implement.jsonl"),
    `${JSON.stringify({ file: ".phronia/spec/guides/index.md", reason: "guides" })}\n`,
  );
  fs.writeFileSync(
    path.join(root, ".phronia", ".runtime", "sessions", "omp_context_limits.json"),
    JSON.stringify({ current_task: ".phronia/tasks/08-13-context-limits" }),
  );
  return { root, taskDir, sessionId };
}

async function runSessionStart(root: string, sessionId: string): Promise<string[]> {
  const messages: { customType?: string; content?: string }[] = [];
  const handlers = new Map<string, OmpEventHandler>();
  loadOmpExtension()({
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: async (message: { customType?: string; content?: string }) => {
      messages.push(message);
    },
  } as never);
  const handler = handlers.get("session_start");
  if (!handler) throw new Error("OMP extension did not register session_start");
  await handler({}, {
    cwd: root,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: () => undefined },
  });
  return messages.map((message) => message.content ?? "");
}

describe("omp templates", () => {
  it("provides the three Phronia sub-agent definitions", () => {
    const agents = getAllAgents();
    expect(agents.map((agent) => agent.name).sort()).toEqual([
      "phronia-check",
      "phronia-implement",
      "phronia-research",
    ]);
  });

  it("each agent has non-empty content and name", () => {
    for (const agent of getAllAgents()) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.content.length).toBeGreaterThan(0);
    }
  });

  it("getExtensionTemplate returns a non-empty string", () => {
    expect(getExtensionTemplate().length).toBeGreaterThan(0);
  });

  it("extension template contains key markers for OMP integration", () => {
    const extension = getExtensionTemplate();
    expect(extension).toContain("before_agent_start");
    expect(extension).toContain("input");
    expect(extension).toContain("session_start");
    expect(extension).toContain("ExtensionAPI");
  });

  it("delegates every assembly event to the core CLI", () => {
    const extension = getExtensionTemplate();
    expect(extension).toContain("runCoreContext");
    expect(extension).toContain('"session-start"');
    expect(extension).toContain('"user-prompt"');
    expect(extension).toContain('"subagent-spawn"');
    expect(extension).toContain("context_only: true");
    // Assembly used to be duplicated here; it must not come back.
    expect(extension).not.toContain("get_context.py");
    expect(extension).not.toContain("parseWorkflowStateBlocks");
    expect(extension).not.toContain("buildTaskContext");
    expect(extension).not.toContain("readContextInjectionLimits");
    expect(extension).not.toContain("process.env.PHRONIA_CONTEXT_ID =");
  });

  it("injects the derived context key into the original Bash params", () => {
    const handler = captureOmpHandlers().get("tool_call");
    if (!handler) throw new Error("OMP extension did not register tool_call");
    const params: { command: string; env?: Record<string, string> } = {
      command: "python3 ./.phronia/scripts/task.py current",
      env: { EXISTING: "kept" },
    };

    handler(
      { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: params },
      { sessionManager: { getSessionId: () => "session/a" } },
    );

    expect(params.env?.PHRONIA_CONTEXT_ID).toBe("omp_session_a");
    expect(params.env?.EXISTING).toBe("kept");
  });

  it("preserves an explicit Bash env override and leaves inline assignments untouched", () => {
    const handler = captureOmpHandlers().get("tool_call");
    if (!handler) throw new Error("OMP extension did not register tool_call");
    const command =
      "PHRONIA_CONTEXT_ID=inline python3 ./.phronia/scripts/task.py current";
    const params: { command: string; env?: Record<string, string> } = {
      command,
      env: { PHRONIA_CONTEXT_ID: "explicit" },
    };

    handler(
      { type: "tool_call", toolName: "bash", toolCallId: "call-2", input: params },
      { sessionManager: { getSessionId: () => "session/b" } },
    );

    expect(params.command).toBe(command);
    expect(params.env?.PHRONIA_CONTEXT_ID).toBe("explicit");
  });

  it("does not mutate non-Bash tool params", () => {
    const handler = captureOmpHandlers().get("tool_call");
    if (!handler) throw new Error("OMP extension did not register tool_call");
    const params: Record<string, unknown> = { path: "README.md" };

    handler(
      { type: "tool_call", toolName: "read", toolCallId: "call-3", input: params },
      { sessionManager: { getSessionId: () => "session/c" } },
    );

    expect(params).toEqual({ path: "README.md" });
  });

  it("session_start sends core session and task context", async () => {
    const { root, sessionId } = makeOmpProject();
    try {
      const contents = await runSessionStart(root, sessionId);
      const sessionContext = contents.find((content) => content.includes("<session-context>")) ?? "";
      const taskContext = contents.find((content) => content.includes("<task-context>")) ?? "";
      expect(sessionContext).toContain("<current-state>");
      expect(taskContext).toContain("# PRD body");
      expect(taskContext).toContain("guides/index.md");
      expect(taskContext.trimEnd()).toMatch(/<\/task-context>$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("before_agent_start returns the core workflow breadcrumb", async () => {
    const { root, sessionId } = makeOmpProject();
    try {
      const handlers = new Map<string, OmpEventHandler>();
      loadOmpExtension()({ on: (event, handler) => handlers.set(event, handler) });
      const input = handlers.get("input");
      const before = handlers.get("before_agent_start");
      if (!input || !before) throw new Error("OMP extension handlers missing");
      const ctx = {
        cwd: root,
        sessionManager: { getSessionId: () => sessionId },
      };
      await input({ type: "input", text: "Continue the task" }, ctx);
      const result = (await before({ type: "before_agent_start" }, ctx)) as {
        message?: { customType?: string; content?: string };
      };
      expect(result.message?.customType).toBe("phronia-workflow-state");
      expect(result.message?.content).toContain("<workflow-state>");
      expect(result.message?.content).toContain("in_progress");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the breadcrumb when the prompt carries the escape hatch", async () => {
    const { root, sessionId } = makeOmpProject();
    try {
      const handlers = new Map<string, OmpEventHandler>();
      loadOmpExtension()({ on: (event, handler) => handlers.set(event, handler) });
      const input = handlers.get("input");
      const before = handlers.get("before_agent_start");
      if (!input || !before) throw new Error("OMP extension handlers missing");
      const ctx = {
        cwd: root,
        sessionManager: { getSessionId: () => sessionId },
      };
      await input({ type: "input", text: "no-trellis just chat" }, ctx);
      expect(await before({ type: "before_agent_start" }, ctx)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no settings.json or Python hooks exist in the template directory", () => {
    // OMP is extension-backed: native provider auto-discovers .omp/ subdirs,
    // so no settings.json is needed and no Python hooks should be present.
    expect(fs.existsSync(path.join(templateDir, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(templateDir, "hooks"))).toBe(false);

    // Agents must not reference Python hook scripts
    for (const agent of getAllAgents()) {
      expect(agent.content).not.toContain("inject-subagent-context.py");
    }
  });
});

describe("omp command frontmatter", () => {
  it("collectOmpTemplates produces commands with YAML frontmatter", () => {
    const templates = collectOmpTemplates();
    const continueCmd = templates.get(".omp/commands/phronia-continue.md");
    const finishCmd = templates.get(".omp/commands/phronia-finish-work.md");

    expect(continueCmd).toBeDefined();
    expect(finishCmd).toBeDefined();

    // Both must start with YAML frontmatter
    expect(continueCmd).toMatch(/^---\ndescription: .+\n---\n\n/);
    expect(finishCmd).toMatch(
      /^---\ndescription: .+\nargument-hint: .+\n---\n\n/,
    );

    // Neither should retain the H1 heading from the source template
    expect(continueCmd).not.toMatch(/^---[\s\S]*?---\n\n# /);
    expect(finishCmd).not.toMatch(/^---[\s\S]*?---\n\n# /);
  });

  it("collectOmpTemplates does not emit a start command", () => {
    const templates = collectOmpTemplates();
    expect(templates.has(".omp/commands/phronia-start.md")).toBe(false);
  });
});
