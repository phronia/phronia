/**
 * ZCode configurator.
 *
 * ZCode (智谱) is an agentCapable class-1 platform. Its hooks are registered by
 * a project-local plugin loaded through `.zcode/config.json` `plugins.dirs`;
 * the plugin bridge calls `phronia hook`, which resolves the nearest
 * `.phronia` root. Output paths:
 * - `.zcode/skills/` — ZCode-private workflow and bundled skills
 * - `.zcode/commands/phronia/` — slash commands (invoked as /phronia:<name>)
 * - `.zcode/agents/` — sub-agent definitions with hook-injection fallback
 * - `.zcode/hooks/` — shared Python hook scripts invoked by `phronia hook`
 * - `.zcode/plugins/phronia/` — project-local plugin (manifest + process hooks)
 */

import { AI_TOOLS } from "../types/ai-tools.js";
import { getAllAgents } from "../templates/zcode/index.js";
import { getSharedHookScriptsForPlatform } from "../templates/shared-hooks/index.js";
import { zcodePluginFiles } from "../templates/zcode/plugin.js";
import { ensureZcodePlugin } from "./zcode-plugin.js";
import {
  collectSkillTemplates,
  resolveBundledSkills,
  resolveCommands,
  resolveSkills,
  writeTemplateMap,
} from "./shared.js";

/** Shared hooks directory written for ZCode (mirrors the configure path). */
const ZCODE_HOOKS_DIR = ".zcode/hooks";

/**
 * The ZCode file set — written at init and diffed by `trellis update`.
 */
export function collectZcodeTemplates(): Map<string, string> {
  const config = AI_TOOLS.zcode;
  const ctx = config.templateContext;
  const files = new Map<string, string>();

  // 1. ZCode-private workflow and bundled skills → .zcode/skills/.
  for (const [filePath, content] of collectSkillTemplates(
    ".zcode/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }

  // 2. Commands → .zcode/commands/phronia/
  for (const cmd of resolveCommands(ctx)) {
    files.set(`.zcode/commands/phronia/${cmd.name}.md`, cmd.content);
  }

  // 3. Sub-agents → .zcode/agents/ (hook-inject; templates carry fallback).
  for (const agent of getAllAgents()) {
    files.set(`.zcode/agents/${agent.name}.md`, agent.content);
  }

  // 4. Shared hook scripts → .zcode/hooks/.
  //    Content is platform-independent (no placeholders), collected as-is.
  for (const hook of getSharedHookScriptsForPlatform("zcode")) {
    files.set(`${ZCODE_HOOKS_DIR}/${hook.name}`, hook.content);
  }

  // 5. Project-local plugin: hooks call `phronia hook`, which resolves the
  //    nearest .phronia root. The plugin path itself comes from
  //    ZCODE_PLUGIN_ROOT, so it is independent of the tool cwd.
  for (const [filePath, content] of zcodePluginFiles()) {
    files.set(filePath, content);
  }

  return files;
}

/**
 * Configure ZCode: write platform templates, then install/repair the
 * project-local plugin that registers the hooks.
 */
export async function configureZcode(cwd: string): Promise<void> {
  await writeTemplateMap(cwd, collectZcodeTemplates());
  const result = ensureZcodePlugin(cwd);
  if (process.env.VITEST || process.env.PHRONIA_QUIET) return;
  if (result.changed) {
    process.stderr.write(
      "ℹ️  ZCode: Phronia plugin installed for this workspace; start a new session.\n",
    );
  }
  for (const warning of result.warnings) {
    process.stderr.write(`⚠️  ZCode: ${warning}\n`);
  }
}
