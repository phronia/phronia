/**
 * Install/repair the project-local ZCode plugin.
 *
 * ZCode reads `.zcode/config.json` `plugins.dirs` as an `inline` plugin source
 * and enables those plugins by default. Keeping the plugin inside the project
 * makes `phronia init` / `update` the only lifecycle owner: no marketplace,
 * no global install, no project-relative hook script path.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ZCODE_PLUGIN_DIR,
  ZCODE_PLUGIN_ID,
  zcodePluginFiles,
} from "../templates/zcode/plugin.js";
import { getSharedHookScriptsForPlatform } from "../templates/shared-hooks/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { replacePythonCommandLiterals } from "./shared.js";

export interface ZcodePluginResult {
  changed: boolean;
  pluginDir: string;
  warnings: string[];
}

export interface ZcodePluginOptions {
  /**
   * Write the plugin files. `update` sets this to false because its normal
   * template diff already owns those files and may deliberately skip a
   * user-modified copy; init/doctor use the default (true).
   */
  writeFiles?: boolean;
}

type JsonObject = Record<string, unknown>;

export function ensureZcodePlugin(
  cwd: string,
  options: ZcodePluginOptions = {},
): ZcodePluginResult {
  const root = path.resolve(cwd);
  const pluginDir = path.join(root, ...ZCODE_PLUGIN_DIR.split("/"));
  const warnings: string[] = [];
  let changed = false;

  if (options.writeFiles !== false) {
    const files = new Map(zcodePluginFiles());
    // The plugin bridge delegates to `phronia hook`, which invokes these
    // shims. doctor must install them too, not only init/update.
    for (const hook of getSharedHookScriptsForPlatform("zcode")) {
      files.set(`.zcode/hooks/${hook.name}`, hook.content);
    }
    for (const [relativePath, content] of files) {
      const fullPath = path.join(root, ...relativePath.split("/"));
      const rendered = replacePythonCommandLiterals(content);
      if (readIfExists(fullPath) === rendered) {
        continue;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileAtomic(fullPath, rendered);
      changed = true;
    }
  }

  // Older installs used a project bridge for the external trellis-bridge
  // plugin. The project-local plugin supersedes it.
  const legacyBridge = path.join(
    root,
    ".zcode",
    "bridge",
    "phronia-zcode-bridge.mjs",
  );
  if (fs.existsSync(legacyBridge)) {
    fs.rmSync(legacyBridge, { force: true });
    changed = true;
    removeDirIfEmpty(path.dirname(legacyBridge));
  }

  const configPath = path.join(root, ".zcode", "config.json");
  const existing = readIfExists(configPath);
  let config: JsonObject = {};
  if (existing !== null && existing.trim().length > 0) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (!isJsonObject(parsed)) {
        throw new Error("expected a JSON object");
      }
      config = parsed;
    } catch (error) {
      throw new Error(
        `Cannot install the ZCode plugin: ${path.relative(root, configPath)} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const before = JSON.stringify(config);
  const plugins = isJsonObject(config.plugins)
    ? { ...config.plugins }
    : {};

  if (plugins.enabled === false) {
    warnings.push(
      ".zcode/config.json has plugins.enabled=false; ZCode will not load the Phronia plugin.",
    );
  } else if (plugins.enabled === undefined) {
    plugins.enabled = true;
  }

  const dirs = Array.isArray(plugins.dirs)
    ? plugins.dirs.filter((entry): entry is string => typeof entry === "string")
    : [];
  // ZCode resolves plugins.dirs relative to the host process cwd, not the
  // workspace root, so a relative entry is unreliable after an app restart.
  // Write the absolute path for this machine; doctor/update repair it on a
  // different checkout.
  const pluginDirIndex = dirs.findIndex(
    (entry) => path.resolve(root, entry) === pluginDir,
  );
  if (pluginDirIndex === -1) {
    dirs.push(pluginDir);
  } else if (dirs[pluginDirIndex] !== pluginDir) {
    dirs[pluginDirIndex] = pluginDir;
  }
  plugins.dirs = dirs;

  const enabledPlugins = isJsonObject(plugins.enabledPlugins)
    ? { ...plugins.enabledPlugins }
    : {};
  if (enabledPlugins[ZCODE_PLUGIN_ID] === false) {
    warnings.push(
      `.zcode/config.json disables ${ZCODE_PLUGIN_ID}; enable it to run Phronia hooks.`,
    );
  } else if (enabledPlugins[ZCODE_PLUGIN_ID] !== true) {
    enabledPlugins[ZCODE_PLUGIN_ID] = true;
  }
  plugins.enabledPlugins = enabledPlugins;
  config.plugins = plugins;

  if (isJsonObject(config.hooks) && isJsonObject(config.hooks.events)) {
    const cleaned = removePhroniaHooks(config.hooks.events);
    if (Object.keys(cleaned.events).length === 0) {
      delete config.hooks;
    } else {
      config.hooks = { ...config.hooks, events: cleaned.events };
    }
    if (cleaned.removed > 0) {
      warnings.push(
        `Removed ${cleaned.removed} legacy Phronia workspace hook(s); the plugin is now the only hook source.`,
      );
    }
  }

  if (JSON.stringify(config) !== before) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    changed = true;
  }

  return { changed, pluginDir, warnings };
}

interface CleanedHooks {
  events: JsonObject;
  removed: number;
}

function removePhroniaHooks(events: JsonObject): CleanedHooks {
  let removed = 0;
  const next: JsonObject = {};

  for (const [event, matchers] of Object.entries(events)) {
    if (!Array.isArray(matchers)) {
      next[event] = matchers;
      continue;
    }
    const keptMatchers: unknown[] = [];
    for (const matcher of matchers) {
      if (!isJsonObject(matcher) || !Array.isArray(matcher.hooks)) {
        keptMatchers.push(matcher);
        continue;
      }
      const keptHooks = matcher.hooks.filter((hook) => {
        const owned = isPhroniaHook(hook);
        if (owned) removed += 1;
        return !owned;
      });
      if (keptHooks.length > 0) {
        keptMatchers.push({ ...matcher, hooks: keptHooks });
      }
    }
    if (keptMatchers.length > 0) {
      next[event] = keptMatchers;
    }
  }

  return { events: next, removed };
}

function isPhroniaHook(hook: unknown): boolean {
  if (!isJsonObject(hook)) {
    return false;
  }
  const command = typeof hook.command === "string" ? hook.command : "";
  const args = Array.isArray(hook.args)
    ? hook.args.filter((arg): arg is string => typeof arg === "string").join(" ")
    : "";
  const haystack = `${command} ${args}`;
  return (
    haystack.includes(".zcode/hooks/phronia-hook.py") ||
    haystack.includes("phronia-hook.py") ||
    haystack.includes("phronia zcode-hook") ||
    haystack.includes("phronia hook")
  );
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function removeDirIfEmpty(directory: string): void {
  try {
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
  } catch {
    // Best effort.
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
