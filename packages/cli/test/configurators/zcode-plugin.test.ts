import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureZcodePlugin } from "../../src/configurators/zcode-plugin.js";

describe("ensureZcodePlugin", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-zcode-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("installs the plugin and enables it in .zcode/config.json", () => {
    const result = ensureZcodePlugin(root);

    expect(result.changed).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          root,
          ".zcode",
          "plugins",
          "phronia",
          ".zcode-plugin",
          "plugin.json",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, ".zcode", "plugins", "phronia", "hooks", "bridge.mjs"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, ".zcode", "hooks", "phronia-hook.py")),
    ).toBe(true);

    const config = readConfig(root);
    expect(config.plugins?.dirs).toEqual([result.pluginDir]);
    expect(config.plugins?.enabledPlugins?.["phronia@inline"]).toBe(true);
    expect(config.hooks).toBeUndefined();
  });

  it("is idempotent", () => {
    ensureZcodePlugin(root);
    const second = ensureZcodePlugin(root);
    expect(second.changed).toBe(false);
  });

  it("preserves other plugins, dirs, and user hooks", () => {
    writeConfig(root, {
      plugins: {
        dirs: ["custom/plugin"],
        enabledPlugins: { "other@market": true },
      },
      hooks: {
        events: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "python3 .zcode/hooks/phronia-hook.py --event user-prompt",
                },
                { type: "command", command: "echo keep-me" },
              ],
            },
          ],
        },
      },
    });

    ensureZcodePlugin(root);
    const config = readConfig(root);
    expect(config.plugins?.dirs).toEqual([
      "custom/plugin",
      path.join(root, ".zcode", "plugins", "phronia"),
    ]);
    expect(config.plugins?.enabledPlugins).toEqual({
      "other@market": true,
      "phronia@inline": true,
    });
    expect(config.hooks?.events?.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "echo keep-me" }] },
    ]);
  });

  it("migrates a relative dir to the absolute path ZCode can resolve", () => {
    const relative = ".zcode/plugins/phronia";
    writeConfig(root, { plugins: { dirs: [relative] } });

    ensureZcodePlugin(root);
    expect(readConfig(root).plugins?.dirs).toEqual([
      path.join(root, ".zcode", "plugins", "phronia"),
    ]);
  });

  it("refuses malformed config instead of overwriting it", () => {
    fs.mkdirSync(path.join(root, ".zcode"), { recursive: true });
    fs.writeFileSync(path.join(root, ".zcode", "config.json"), "{ nope");
    expect(() => ensureZcodePlugin(root)).toThrow(/not valid JSON/);
  });

  it("removes the legacy project bridge", () => {
    const bridge = path.join(
      root,
      ".zcode",
      "bridge",
      "phronia-zcode-bridge.mjs",
    );
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.writeFileSync(bridge, "legacy");

    ensureZcodePlugin(root);
    expect(fs.existsSync(bridge)).toBe(false);
    expect(fs.existsSync(path.dirname(bridge))).toBe(false);
  });
});

interface TestConfig {
  plugins?: {
    dirs?: string[];
    enabledPlugins?: Record<string, boolean>;
  };
  hooks?: {
    events?: Record<string, unknown>;
  };
}

function readConfig(root: string): TestConfig {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".zcode", "config.json"), "utf8"),
  ) as TestConfig;
}

function writeConfig(root: string, value: TestConfig): void {
  fs.mkdirSync(path.join(root, ".zcode"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".zcode", "config.json"),
    JSON.stringify(value),
  );
}
