/**
 * Per-turn workflow breadcrumb parsing.
 *
 * `workflow.md` is the only source of truth; there are no fallback bodies.
 * Missing tags surface as a generic line so a broken workflow file stays
 * visible instead of silently losing guidance.
 */

export const BREADCRUMB_TAG_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n(.*?)\n\s*\[\/workflow-state:\1\]/gs;

export function parseBreadcrumbs(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of content.matchAll(BREADCRUMB_TAG_RE)) {
    const status = match[1];
    const body = (match[2] ?? "").trim();
    if (status && body) {
      result[status] = body;
    }
  }
  return result;
}

/**
 * Case-insensitive, word-boundary match. Hyphen counts as a word character,
 * so `no-trellisx`, `xno-trellis`, and `foo-no-trellis` do not match.
 * An empty keyword disables the escape hatch.
 */
export function promptHasSkipKeyword(prompt: string, keyword: string): boolean {
  if (!keyword || typeof prompt !== "string") {
    return false;
  }
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(prompt);
}

/** Codex `inline` mode uses a parallel set of `-inline` breadcrumb tags. */
export function resolveBreadcrumbKey(
  status: string,
  dispatchMode: "auto" | "inline",
): string {
  if (dispatchMode === "inline") {
    return `${status}-inline`;
  }
  return status;
}

export function buildBreadcrumb(options: {
  status: string;
  taskId: string | null;
  body: string | undefined;
}): string {
  const header =
    options.taskId === null
      ? `Status: ${options.status}`
      : `Task: ${options.taskId} (${options.status})`;
  const body = options.body ?? "Refer to workflow.md for current step.";
  return `<workflow-state>\n${header}\n${body}\n</workflow-state>`;
}
