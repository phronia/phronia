import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../../src/templates/opencode/adapters/v2/plugin.js";

interface Registrations {
  context?: (event: Record<string, unknown>) => Promise<void>;
  executeBefore?: (event: Record<string, unknown>) => Promise<void>;
  shellBefore?: (event: Record<string, unknown>) => Promise<void>;
}

function fakeContext(directory: string, registrations: Registrations) {
  return {
    location: { directory },
    session: {
      hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void>) => {
        if (name === "context") registrations.context = callback;
        return { dispose: async () => undefined };
      },
    },
    tool: {
      hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void>) => {
        if (name === "execute.before") registrations.executeBefore = callback;
        return { dispose: async () => undefined };
      },
    },
    shell: {
      hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void>) => {
        if (name === "create.before") registrations.shellBefore = callback;
        return { dispose: async () => undefined };
      },
    },
  };
}

describe("opencode v2 shim", () => {
  let root: string;
  let previousCli: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phronia-opencode-v2-"));
    previousCli = process.env.PHRONIA_CLI_PATH;
    process.env.PHRONIA_CLI_PATH = join(root, "fake-cli.js");
    process.env.PHRONIA_HOOKS = "1";
    delete process.env.OPENCODE_NON_INTERACTIVE;
    writeFileSync(
      process.env.PHRONIA_CLI_PATH,
      `
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const eventIndex = process.argv.indexOf("--event");
  const event = eventIndex >= 0 ? process.argv[eventIndex + 1] : "";
  const blocks =
    event === "session-start"
      ? [{ id: "session", text: "SESSION", priority: 0 }]
      : event === "user-prompt"
        ? [{ id: "prompt", text: "BREADCRUMB", priority: 0 }]
        : [];
  const mutations =
    event === "subagent-spawn"
      ? [{ op: "set-prompt", value: "INJECTED", marker: "phronia" }]
      : [];
  process.stdout.write(JSON.stringify({ blocks, mutations, envelope: "none" }));
});
`,
      "utf8",
    );
  });

  afterEach(() => {
    if (previousCli === undefined) delete process.env.PHRONIA_CLI_PATH;
    else process.env.PHRONIA_CLI_PATH = previousCli;
    delete process.env.PHRONIA_HOOKS;
    rmSync(root, { recursive: true, force: true });
  });

  it("injects session context into system and breadcrumb into messages", async () => {
    const registrations: Registrations = {};
    const cleanup = await plugin.setup(fakeContext(root, registrations) as never);
    expect(typeof cleanup).toBe("function");
    expect(registrations.context).toBeTypeOf("function");

    const event: Record<string, unknown> = {
      sessionID: "s1",
      agent: "build",
      system: [],
      messages: [
        {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };
    await registrations.context?.(event);

    expect(event.system).toEqual([{ type: "text", text: "SESSION" }]);
    expect(event.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      { role: "system", content: [{ type: "text", text: "BREADCRUMB" }] },
    ]);
  });

  it("rewrites a Phronia subagent prompt and leaves other agents alone", async () => {
    const registrations: Registrations = {};
    await plugin.setup(fakeContext(root, registrations) as never);

    const matching = {
      tool: "subagent",
      sessionID: "s1",
      input: { agent: "phronia-implement", prompt: "do the work" },
    };
    await registrations.executeBefore?.(matching);
    expect(matching.input.prompt).toBe("INJECTED");

    const other = {
      tool: "subagent",
      sessionID: "s1",
      input: { agent: "general", prompt: "do the work" },
    };
    await registrations.executeBefore?.(other);
    expect(other.input.prompt).toBe("do the work");
  });

  it("marks shell children with an explicit host", async () => {
    const registrations: Registrations = {};
    await plugin.setup(fakeContext(root, registrations) as never);
    const event: Record<string, unknown> = { env: {} };
    await registrations.shellBefore?.(event);
    expect(event.env).toEqual({ PHRONIA_HOST: "opencode" });
  });

  it("stays inert when hooks are disabled", async () => {
    process.env.PHRONIA_HOOKS = "0";
    const registrations: Registrations = {};
    const cleanup = await plugin.setup(fakeContext(root, registrations) as never);
    expect(cleanup).toBeUndefined();
    expect(registrations.context).toBeUndefined();
  });
});
