import { describe, expect, it } from "vitest";
import { getAllAgents } from "../../src/templates/zcode/index.js";
import {
  ZCODE_PLUGIN_DIR,
  ZCODE_PLUGIN_ID,
  zcodePluginFiles,
} from "../../src/templates/zcode/plugin.js";

const EXPECTED_AGENT_NAMES = [
  "phronia-check",
  "phronia-implement",
  "phronia-research",
];

describe("zcode getAllAgents", () => {
  it("returns the expected custom agent set", () => {
    const agents = getAllAgents();
    const names = agents.map((agent) => agent.name);
    expect(names).toEqual(EXPECTED_AGENT_NAMES);
  });

  it("each agent is a Markdown file with YAML frontmatter", () => {
    for (const agent of getAllAgents()) {
      const content = agent.content.replace(/\r\n/g, "\n");
      expect(content.length).toBeGreaterThan(0);
      expect(content).toMatch(/^---\n/);
      expect(content).toContain("name: ");
      expect(content).toContain("description:");
      expect(content).toContain("color:");
    }
  });
});

describe("zcode project-local plugin", () => {
  it("ships a manifest, hooks, and a thin CLI bridge", () => {
    const files = zcodePluginFiles();
    expect([...files.keys()]).toEqual([
      `${ZCODE_PLUGIN_DIR}/.zcode-plugin/plugin.json`,
      `${ZCODE_PLUGIN_DIR}/hooks/hooks.json`,
      `${ZCODE_PLUGIN_DIR}/hooks/bridge.mjs`,
    ]);
    expect(ZCODE_PLUGIN_ID).toBe("phronia@inline");

    const manifest = JSON.parse(
      files.get(`${ZCODE_PLUGIN_DIR}/.zcode-plugin/plugin.json`) ?? "{}",
    ) as { name?: string; version?: string };
    expect(manifest.name).toBe("phronia");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);

    const bridge = files.get(`${ZCODE_PLUGIN_DIR}/hooks/bridge.mjs`) ?? "";
    expect(bridge).toContain('"hook"');
    expect(bridge).toContain('"--platform"');
    expect(bridge).toContain('"zcode"');
    // The plugin path is stable; root discovery belongs to the CLI.
    expect(bridge).not.toContain("findProjectRoot");
  });

  it("registers process hooks with stable plugin-root paths", () => {
    const files = zcodePluginFiles();
    const hooks = JSON.parse(
      files.get(`${ZCODE_PLUGIN_DIR}/hooks/hooks.json`) ?? "{}",
    ) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { type: string; command: string; args: string[] }[] }[]
      >;
    };

    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);

    const entries = Object.values(hooks.hooks).flatMap((matchers) =>
      matchers.flatMap((matcher) => matcher.hooks),
    );
    const events = entries.map((hook) => hook.args.at(-1));
    expect(events).toEqual(
      expect.arrayContaining([
        "session-start",
        "user-prompt",
        "subagent-spawn",
        "pre-shell",
      ]),
    );
    for (const hook of entries) {
      expect(hook.type).toBe("process");
      expect(hook.command).toBe("node");
      expect(hook.args[0]).toBe("${ZCODE_PLUGIN_ROOT}/hooks/bridge.mjs");
      expect(hook.args).not.toContain("ZCODE_PROJECT_DIR");
    }
  });
});

describe("zcode class-1 agent fallback protocol", () => {
  it("keeps source agents prelude-free but gives implement/check hook fallback instructions", () => {
    const agents = getAllAgents();
    for (const agent of agents) {
      if (
        agent.name === "phronia-implement" ||
        agent.name === "phronia-check"
      ) {
        expect(agent.content).not.toContain("Load Phronia Context First");
        expect(agent.content).toContain("Phronia Context Loading Protocol");
        expect(agent.content).toContain("<!-- phronia-hook-injected -->");
        expect(agent.content).toContain("Active task:");
      }
    }
  });

  it("does not add context fallback instructions to research", () => {
    const agents = getAllAgents();
    const research = agents.find((agent) => agent.name === "phronia-research");
    expect(research).toBeDefined();
    if (!research) return;
    expect(research.content).not.toContain("Phronia Context Loading Protocol");
    expect(research.content).not.toContain("Load Phronia Context First");
    expect(research.content).toContain("{TASK_DIR}/research/");
  });
});
