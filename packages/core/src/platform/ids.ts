/**
 * Platform identity — the single source for the platform union.
 *
 * `packages/cli` derives `AITool`, `TemplateDir`, and `CliFlag` from this list
 * so adding a platform touches one constant plus its registry entry.
 */

export const PLATFORM_IDS = [
  "claude-code",
  "cursor",
  "opencode",
  "codex",
  "kilo",
  "kiro",
  "gemini",
  "antigravity",
  "devin",
  "qoder",
  "codebuddy",
  "copilot",
  "droid",
  "dsh",
  "pi",
  "reasonix",
  "zcode",
  "trae",
  "omp",
  "grok",
  "kimi",
  "snow",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

/** Short ids used in context keys and hook-env detection. */
export const PLATFORM_SHORT_IDS: Record<PlatformId, string> = {
  "claude-code": "claude",
  cursor: "cursor",
  opencode: "opencode",
  codex: "codex",
  kilo: "kilo",
  kiro: "kiro",
  gemini: "gemini",
  antigravity: "antigravity",
  devin: "devin",
  qoder: "qoder",
  codebuddy: "codebuddy",
  copilot: "copilot",
  droid: "droid",
  dsh: "dsh",
  pi: "pi",
  reasonix: "reasonix",
  zcode: "zcode",
  trae: "trae",
  omp: "omp",
  grok: "grok",
  kimi: "kimi",
  snow: "snow",
};

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

/** Map harness short names to canonical platform ids. */
const SHORT_TO_ID: Record<string, PlatformId> = {
  claude: "claude-code",
  factory: "droid",
  "github-copilot": "copilot",
};

export function normalizePlatformId(value: string): PlatformId | null {
  if (isPlatformId(value)) {
    return value;
  }
  return SHORT_TO_ID[value] ?? null;
}
