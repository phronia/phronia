/**
 * AI Tool Types and Registry
 *
 * Defines supported AI coding tools and which command templates they can use.
 * The platform union and capability matrix live in `@phronia/core/platform`;
 * this module only adds CLI-side render metadata and derives the legacy
 * booleans from the matrix.
 */

import {
  CAPABILITIES,
  PLATFORM_IDS,
  type Mechanism,
  type PlatformCapabilities,
  type PlatformId,
} from "@phronia/core/platform";

/** Supported AI coding tools. */
export type AITool = PlatformId;

/**
 * Directory name for each platform's template + CLI flag. Kept as a map so a
 * platform whose id differs from its directory (claude-code) still derives
 * both unions from `PLATFORM_IDS`.
 */
export const PLATFORM_DIR_NAMES = {
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
} as const satisfies Record<PlatformId, string>;

type PlatformDirName = (typeof PLATFORM_DIR_NAMES)[PlatformId];

/** Template directory categories. */
export type TemplateDir = "common" | PlatformDirName;

/** CLI flag names for platform selection (e.g., --claude, --cursor). */
export type CliFlag = PlatformDirName;

/**
 * Template context for placeholder resolution.
 * Controls how common templates are rendered per platform.
 */
export interface TemplateContext {
  /** Prefix for cross-referencing other commands/skills */
  cmdRefPrefix:
    | "/phronia:"
    | "/phronia-"
    | "$"
    | "/"
    | "/skill phronia-"
    | "/skill:phronia-"
    | "phronia-";
  /** Description of AI executor actions shown in role tables */
  executorAI:
    | "Bash scripts or Task calls"
    | "Bash scripts or tool calls"
    | "Bash scripts or Agent calls"
    | "Bash scripts or file reads";
  /** Label for user-invocable actions */
  userActionLabel:
    | "Slash commands"
    | "Skills"
    | "Workflows"
    | "Prompts"
    | "Commands";
  /** Platform supports spawning sub-agents with isolated context */
  readonly agentCapable: boolean;
  /**
   * @deprecated Use `autoSessionStart`. Kept for `{{#HAS_HOOKS}}` one version.
   */
  readonly hasHooks: boolean;
  /** Any automatic session-start injection (hook/plugin/extension/config) */
  readonly autoSessionStart: boolean;
  /**
   * CLI flag value for this platform (e.g. "claude", "codex", "kiro").
   * Substituted into template commands via {{CLI_FLAG}} so rendered skill /
   * command files can pass `--platform <flag>` to scripts that need to know
   * the invoking platform, removing the need to re-detect at runtime.
   * Duplicates the top-level `AIToolConfig.cliFlag` for convenience — the
   * invariant is maintained in `AI_TOOLS` config blocks.
   */
  cliFlag: CliFlag;
}

/**
 * Configuration for an AI tool
 */
export interface AIToolConfig {
  /** Display name of the tool */
  name: string;
  /** Command template directory names to include */
  templateDirs: TemplateDir[];
  /** Config directory name in the project root (e.g., ".claude") */
  configDir: string;
  /**
   * Whether the platform supports the shared `.agents/skills/` layer
   * (agentskills.io open standard). When true, `.agents/skills` is added
   * to the platform's managed paths automatically.
   */
  supportsAgentSkills?: boolean;
  /** Additional managed paths beyond configDir (e.g., .github/hooks for Copilot) */
  extraManagedPaths?: string[];
  /** CLI flag name for --flag options (e.g., "claude" for --claude) */
  cliFlag: CliFlag;
  /** Whether this tool is checked by default in interactive init prompt */
  defaultChecked: boolean;
  /** Capability matrix entry (single source for behaviour bindings). */
  readonly capabilities: PlatformCapabilities;
  /** Derived: one or more behaviours run through the Python shim */
  readonly hasPythonHooks: boolean;
  /**
   * Optional user-global compatibility plugin for platform versions where
   * project-level integration is unavailable. Phronia may surface a manual
   * installation hint, but leaves installation and lifecycle management to
   * the platform UI.
   */
  globalHookPlugin?: {
    name: string;
    marketplaceUrl: string;
  };
  /** Template context for placeholder resolution in common templates */
  templateContext: TemplateContext;
}

/** Render metadata before the capability matrix fills in the derived bits. */
type AIToolBase = Omit<
  AIToolConfig,
  "capabilities" | "hasPythonHooks" | "templateContext"
> & {
  templateContext: Omit<
    TemplateContext,
    "agentCapable" | "hasHooks" | "autoSessionStart"
  >;
};

/**
 * Registry of all supported AI tools and their configurations.
 * This is the single source of truth for platform data.
 *
 * When adding a new platform, add an entry to `PLATFORM_IDS`, the capability
 * matrix, and this registry; the unions and derived booleans follow.
 */
const AI_TOOL_BASES: Record<AITool, AIToolBase> = {
  "claude-code": {
    name: "Claude Code",
    templateDirs: ["common", "claude"],
    configDir: ".claude",
    cliFlag: "claude",
    defaultChecked: true,
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      cliFlag: "claude",
    },
  },
  cursor: {
    name: "Cursor",
    templateDirs: ["common", "cursor"],
    configDir: ".cursor",
    cliFlag: "cursor",
    defaultChecked: true,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      cliFlag: "cursor",
    },
  },
  opencode: {
    name: "OpenCode",
    templateDirs: ["common", "opencode"],
    configDir: ".opencode",
    cliFlag: "opencode",
    defaultChecked: false,
    // The session-start plugin auto-injects context, so `autoSessionStart` is
    // true and `filterCommands` drops the `/start` fallback. The capability
    // matrix is the source of that decision.
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      cliFlag: "opencode",
    },
  },
  codex: {
    name: "Codex (also writes .agents/skills/ — read by Cursor, Gemini CLI, GitHub Copilot, Amp, Kimi Code)",
    templateDirs: ["common", "codex"],
    configDir: ".codex",
    supportsAgentSkills: true,
    cliFlag: "codex",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "$",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      cliFlag: "codex",
    },
  },
  kilo: {
    name: "Kilo CLI",
    templateDirs: ["common"],
    configDir: ".kilocode",
    cliFlag: "kilo",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or file reads",
      userActionLabel: "Workflows",
      cliFlag: "kilo",
    },
  },
  kiro: {
    name: "Kiro Code",
    templateDirs: ["common", "kiro"],
    configDir: ".kiro/skills",
    extraManagedPaths: [".kiro/agents", ".kiro/hooks"],
    cliFlag: "kiro",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "$",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      cliFlag: "kiro",
    },
  },
  gemini: {
    name: "Gemini CLI",
    templateDirs: ["common", "gemini"],
    configDir: ".gemini",
    supportsAgentSkills: true,
    cliFlag: "gemini",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Slash commands",
      cliFlag: "gemini",
    },
  },
  antigravity: {
    name: "Antigravity",
    templateDirs: ["common"],
    configDir: ".agent/workflows",
    extraManagedPaths: [".agent/skills"],
    cliFlag: "antigravity",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/",
      executorAI: "Bash scripts or file reads",
      userActionLabel: "Workflows",
      cliFlag: "antigravity",
    },
  },
  devin: {
    name: "Devin",
    templateDirs: ["common"],
    configDir: ".devin/workflows",
    extraManagedPaths: [".devin/skills"],
    cliFlag: "devin",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or file reads",
      userActionLabel: "Workflows",
      cliFlag: "devin",
    },
  },
  qoder: {
    name: "Qoder",
    templateDirs: ["common", "qoder"],
    configDir: ".qoder",
    cliFlag: "qoder",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "$",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      cliFlag: "qoder",
    },
  },
  codebuddy: {
    name: "CodeBuddy",
    templateDirs: ["common", "codebuddy"],
    configDir: ".codebuddy",
    cliFlag: "codebuddy",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      cliFlag: "codebuddy",
    },
  },
  copilot: {
    name: "GitHub Copilot",
    templateDirs: ["common", "copilot"],
    configDir: ".github/copilot",
    extraManagedPaths: [
      ".github/agents",
      ".github/copilot-instructions.md",
      ".github/hooks",
      ".github/prompts",
      ".github/skills",
    ],
    cliFlag: "copilot",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Prompts",
      cliFlag: "copilot",
    },
  },
  droid: {
    name: "Factory Droid",
    templateDirs: ["common", "droid"],
    configDir: ".factory",
    cliFlag: "droid",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      cliFlag: "droid",
    },
  },
  dsh: {
    // DeepSeek Harness (dsh) is a skills-first pull-based host: it reads
    // `.agents/skills/` (agentskills.io, rank-200 project root) and its own
    // `.dsh/skills/` (rank-100 project root) natively and the agent loads
    // skills by name through its skill-loader tool. No session-start hook
    // ships in the default web/headless profiles, so `hasHooks: false` and
    // `phronia-start` stays as a user-invocable skill. Entry skills reference
    // other skills by bare name (`phronia-<name>`), hence `cmdRefPrefix:
    // "phronia-"`.
    name: "DeepSeek Harness (dsh)",
    templateDirs: ["common", "dsh"],
    configDir: ".dsh",
    supportsAgentSkills: true,
    cliFlag: "dsh",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "phronia-",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      cliFlag: "dsh",
    },
  },
  pi: {
    // Pi also writes .agents/skills/, which is read by Cursor, Gemini CLI,
    // GitHub Copilot, Amp, and Kimi Code. Keep that detail here rather than
    // in `name` — `name` leaks verbatim into `trellis platforms` output and
    // init checkboxes, where a long parenthetical reads badly.
    name: "Pi Agent",
    templateDirs: ["common", "pi"],
    configDir: ".pi",
    supportsAgentSkills: true,
    cliFlag: "pi",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Slash commands",
      cliFlag: "pi",
    },
  },
  reasonix: {
    name: "Reasonix",
    templateDirs: ["common", "reasonix"],
    configDir: ".reasonix",
    cliFlag: "reasonix",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/skill phronia-",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      cliFlag: "reasonix",
    },
  },
  zcode: {
    name: "ZCode",
    templateDirs: ["common", "zcode"],
    configDir: ".zcode",
    // `.zcode/cli/agents` is the pre-ZCode-update discovery path. Kept managed
    // during the transition so `trellis update --migrate` (rename-dir →
    // `.zcode/agents/`) and `trellis uninstall` can clean up the now-empty
    // `.zcode/cli/` parent. Drop this entry once the migration has shipped and
    // no project still holds the legacy dir. Only empty dirs are ever removed,
    // so user files are never touched (see cleanupEmptyDirs in update.ts).
    extraManagedPaths: [
      ".zcode/cli/agents",
      ".zcode/agents",
      ".zcode/commands",
      ".zcode/skills",
      // Hook implementations written by configureZcode. On ZCode builds that
      // disable project hook registration, trellis-bridge invokes them instead.
      ".zcode/hooks",
    ],
    cliFlag: "zcode",
    defaultChecked: false,
    globalHookPlugin: {
      name: "trellis-bridge",
      marketplaceUrl: "https://github.com/CNHLAIA/ZCode-Phronia-Plugin.git",
    },
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or Agent calls",
      userActionLabel: "Skills",
      // ZCode supports project hook registration through .zcode/config.json.
      // On builds that disable it, the optional global trellis-bridge plugin
      // registers the same events and delegates to the project hook scripts.
      // PreToolUse can mutate sub-agent prompts, so either path is class-1.
      cliFlag: "zcode",
    },
  },
  trae: {
    name: "Trae",
    templateDirs: ["common", "trae"],
    configDir: ".trae",
    cliFlag: "trae",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Commands",
      cliFlag: "trae",
    },
  },
  omp: {
    name: "Oh My Pi",
    templateDirs: ["common", "omp"],
    configDir: ".omp",
    cliFlag: "omp",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      cliFlag: "omp",
    },
  },
  /**
   * Grok Build (xAI) — class-2 pull-based platform.
   *
   * Phase 0 verified (Grok 0.2.101): skills/agents/AGENTS.md load correctly;
   * Claude-style hook `additionalContext` is NOT injected into the model.
   * Do not set hasHooks/hasPythonHooks true until Grok consumes hook stdout.
   * Commands are flat under `.grok/commands/phronia-*.md` (Grok slash-command layout).
   */
  grok: {
    name: "Grok Build",
    templateDirs: ["common", "grok"],
    configDir: ".grok",
    extraManagedPaths: [".grok/skills", ".grok/commands", ".grok/agents"],
    cliFlag: "grok",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or Agent calls",
      userActionLabel: "Skills",
      cliFlag: "grok",
    },
  },
  /**
   * Kimi Code CLI — class-2 pull-based platform.
   *
   * Kimi reads project skills from `.kimi-code/skills/` AND the shared
   * `.agents/skills/` (agentskills.io standard), so workflow/bundled skills go
   * to the shared root via the neutral resolver (byte-identical to
   * Codex/Gemini/Pi writes) while user-invocable entry points
   * (`phronia-start` / `phronia-continue` / `phronia-finish-work`, invoked as
   * `/skill:phronia-<name>`) and the Phronia sub-agent prompts live under
   * `.kimi-code/skills/`.
   *
   * Kimi has no project-level hooks/settings file Phronia may write (hooks are
   * user-level `~/.kimi-code/config.toml` only), so the Phronia agent prompts
   * keep the pull-based prelude. They ship both as skills and as project-level
   * custom sub-agent definitions under `.kimi-code/agents/` (Claude
   * Code-compatible frontmatter), so the main session can dispatch
   * `phronia-<name>` sub-agents directly.
   */
  kimi: {
    name: "Kimi Code",
    templateDirs: ["common", "kimi"],
    configDir: ".kimi-code",
    supportsAgentSkills: true,
    cliFlag: "kimi",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/skill:phronia-",
      executorAI: "Bash scripts or Agent calls",
      userActionLabel: "Slash commands",
      cliFlag: "kimi",
    },
  },
  /**
   * Snow CLI - class-1 platform.
   *
   * Skills: `.snow/skills/` (Claude Code Skills compatible)
   * Commands: `.snow/commands/phronia-*.json` (type: prompt)
   * Agents: `.snow/agents/` (project discovery; no class-2 pull prelude)
   * Hooks: `.snow/hooks/` emit additionalContext JSON (session/user/sub-agent)
   *
   * hasHooks=true: SessionStart injects context -> phronia-start is filtered out.
   * hasPythonHooks=true: ships write-phronia-context.py under .snow/hooks/.
   * Primary agent path is `.snow/agents/*.md` only (no legacy JSON fragment).
   *
   * CLI flag: `--snow`.
   * Detection requires Phronia-owned template hashes under `.snow/skills`, so
   * native Snow settings, commands, agents, or skills are not false positives.
   */
  snow: {
    name: "Snow CLI",
    templateDirs: ["common", "snow"],
    configDir: ".snow/skills",
    extraManagedPaths: [
      ".snow/commands",
      ".snow/agents",
      ".snow/hooks",
      ".snow/SNOW.md",
    ],
    cliFlag: "snow",
    defaultChecked: false,
    templateContext: {
      cmdRefPrefix: "/phronia-",
      executorAI: "Bash scripts or Agent calls",
      userActionLabel: "Skills",
      cliFlag: "snow",
    },
  },
};

/**
 * Derive the compatibility booleans from the capability matrix.
 *
 * `hasPythonHooks` asks whether any *runtime* behaviour is a Python hook; the
 * native agent-definition marker is excluded because it is not a shim.
 */
function mechanismIsAutoSessionStart(mechanism: Mechanism): boolean {
  return (
    mechanism.kind === "hook" ||
    mechanism.kind === "plugin" ||
    mechanism.kind === "extension" ||
    mechanism.kind === "config"
  );
}

function defineTool(id: AITool, base: AIToolBase): AIToolConfig {
  const capabilities = CAPABILITIES[id];
  const behavior = capabilities.behavior;
  const agentCapable = behavior.agentDefinitions.kind !== "none";
  const autoSessionStart = mechanismIsAutoSessionStart(behavior.sessionStart);
  const hasPythonHooks = [
    behavior.sessionStart,
    behavior.subagentContext,
    behavior.workflowState,
    behavior.shellIdentity,
  ].some(
    (mechanism) => mechanism.kind === "hook" || mechanism.kind === "config",
  );
  const templateContext = { ...base.templateContext } as TemplateContext;
  Object.defineProperties(templateContext, {
    agentCapable: { value: agentCapable, enumerable: true },
    hasHooks: { value: autoSessionStart, enumerable: true },
    autoSessionStart: { value: autoSessionStart, enumerable: true },
  });
  return Object.defineProperties(
    { ...base, capabilities, templateContext } as AIToolConfig,
    {
      hasPythonHooks: { value: hasPythonHooks, enumerable: true },
    },
  );
}

/** Platform registry with capability-derived compatibility flags. */
export const AI_TOOLS: Record<AITool, AIToolConfig> = Object.fromEntries(
  PLATFORM_IDS.map((id) => [id, defineTool(id, AI_TOOL_BASES[id])]),
) as Record<AITool, AIToolConfig>;

/**
 * Get the configuration for a specific AI tool
 */
export function getToolConfig(tool: AITool): AIToolConfig {
  return AI_TOOLS[tool];
}

/**
 * Get all managed paths for a specific tool.
 */
export function getManagedPaths(tool: AITool): string[] {
  const config = AI_TOOLS[tool];
  const paths = [config.configDir];
  if (config.supportsAgentSkills) {
    paths.push(".agents/skills");
  }
  if (config.extraManagedPaths) {
    paths.push(...config.extraManagedPaths);
  }
  return paths;
}

/**
 * Get template directories for a specific tool
 */
export function getTemplateDirs(tool: AITool): TemplateDir[] {
  return AI_TOOLS[tool].templateDirs;
}
