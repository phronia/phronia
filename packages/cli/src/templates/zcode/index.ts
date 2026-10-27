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
 * Hook registration lives in the project-local plugin under
 * `.zcode/plugins/phronia/`; the shared Python shims are still written to
 * `.zcode/hooks/` and invoked by `phronia hook`.
 */

import { createTemplateReader, type AgentTemplate } from "../template-utils.js";

export type { AgentTemplate };

const { listMdAgents } = createTemplateReader(
  import.meta.url,
  "templates/zcode",
);

/** Sub-agent definitions (phronia-implement, phronia-check, phronia-research). */
export function getAllAgents(): AgentTemplate[] {
  return listMdAgents();
}
