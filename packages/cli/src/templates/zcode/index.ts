/**
 * ZCode template module.
 *
 * ZCode (智谱) is an agentic AI coding tool that supports multi-agent
 * collaboration. It stores agents as `.zcode/agents/<name>.md`
 * (Markdown with YAML frontmatter: name, description, color).
 *
 * phronia-implement and phronia-check use pull-based context injection.
 * phronia-research is intentionally standalone: it does not receive the
 * implement/check prelude, and persists findings under the active task's
 * research directory instead.
 *
 * ZCode 3.x supports a workspace hook config at `.zcode/config.json`
 * (SessionStart + UserPromptSubmit). Shared Python hook scripts are written
 * to `.zcode/hooks/` and registered via the config. The config schema is the
 * workspace form: `{ hooks: { enabled: true, events: { <Event>: [...] } } }`
 * — distinct from plugin `hooks.json` files (no `enabled`/`events` wrapper).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTemplateReader,
  type AgentTemplate,
  type HookTemplate,
} from "../template-utils.js";
import { assetDir } from "../asset-root.js";

export type { AgentTemplate, HookTemplate };

const { listMdAgents, getSettings } = createTemplateReader(import.meta.url, "templates/zcode");

/** Sub-agent definitions (phronia-implement, phronia-check, phronia-research). */
export function getAllAgents(): AgentTemplate[] {
  return listMdAgents();
}

/** Hook configuration written to `.zcode/config.json` (workspace config form). */
export function getHooksConfig(): HookTemplate {
  return getSettings("config.json");
}

/**
 * Self-owned bridge for builds where project hooks are disabled. The file is
 * copied into the project so users can point their global ZCode plugin at it
 * without depending on a third-party repository.
 */
export function getBridgeTemplate(): string {
  const here = assetDir(import.meta.url, "templates/zcode");
  return readFileSync(join(here, "bridge", "phronia-zcode-bridge.mjs"), "utf-8");
}
