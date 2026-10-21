/**
 * Session-start workflow overview extraction.
 *
 * Ported from `session-start.py`: take `## Phase Index` up to
 * `## Phase 1: Plan`, strip the per-turn breadcrumb tags (the hook owns
 * those) and HTML comments, then collapse blank-line runs.
 */

export function extractRange(
  content: string,
  startHeader: string,
  endHeader: string,
): string {
  const lines = content.split(/\r\n|\r|\n/);
  const startMatch = `## ${startHeader}`;
  const endMatch = `## ${endHeader}`;
  let start: number | null = null;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = (lines[index] ?? "").trim();
    if (start === null && stripped === startMatch) {
      start = index;
      continue;
    }
    if (start !== null && stripped === endMatch) {
      end = index;
      break;
    }
  }
  if (start === null) {
    return "";
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

export function stripBreadcrumbTagBlocks(content: string): string {
  const stripped = content
    .replace(
      /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n.*?\n\s*\[\/workflow-state:\1\]/gs,
      "",
    )
    .replace(/<!--.*?-->/gs, "")
    .replace(/^\[(?!\/?workflow-state:)[^\]\n]+\]\s*\n?/gm, "");
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildWorkflowOverview(
  content: string | null,
  workflowPath: string,
): string {
  if (!content) {
    return "No workflow.md found";
  }
  const phases = extractRange(content, "Phase Index", "Phase 1: Plan");
  const lines = [
    "# Development Workflow - Session Summary",
    `Full guide: ${workflowPath}. Step detail: \`python3 ./${workflowPath.replace(
      /workflow\.md$/,
      "scripts/get_context.py",
    )} --mode phase --step <X.Y>\`.`,
    "",
  ];
  if (phases) {
    lines.push(stripBreadcrumbTagBlocks(phases).trimEnd());
  }
  return lines.join("\n").trimEnd();
}
