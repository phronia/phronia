/**
 * Platform capability matrix.
 *
 * Replaces the old `agentCapable` / `hasHooks` / `hasPythonHooks` booleans.
 * Every platform declares all five runtime behaviours; `none` must carry a
 * reason. Environment capabilities and loop control are separate dimensions.
 */

import { PLATFORM_IDS, type PlatformId } from "./ids.js";

export type Mechanism =
  | { kind: "hook"; event: string; detail?: string }
  | { kind: "plugin"; event: string; detail?: string }
  | { kind: "extension"; event: string; detail?: string }
  | { kind: "config"; detail?: string }
  | { kind: "prelude"; detail?: string }
  | { kind: "env-file"; detail?: string }
  | { kind: "tool-prefix"; detail?: string }
  | { kind: "native"; detail?: string }
  | { kind: "none"; reason: string };

export interface BehaviorBindings {
  sessionStart: Mechanism;
  subagentContext: Mechanism;
  workflowState: Mechanism;
  shellIdentity: Mechanism;
  agentDefinitions: Mechanism;
}

export type EnvCapability = "supported" | "degraded" | "unsupported";

export interface EnvironmentCapabilities {
  gitRepo: EnvCapability;
  gitRemote: EnvCapability;
  symlinks: EnvCapability;
}

export type LoopControl = "none" | "hooks" | "full";

/**
 * Sub-agent execution dimensions (design.md §22.1, W0 capability report).
 *
 * `unknown` is first-class: an unverified platform must fail closed, not be
 * silently treated as supporting coordinator mode.
 */
export type SubagentExecution =
  | "unknown"
  | "none"
  | "single"
  | "parallel"
  | "nested";

export type SubagentWorkspace = "unknown" | "none" | "inherited" | "per-task";

export type SubagentIdentity = "unknown" | "none" | "shared" | "isolated";

export interface SubagentCapabilities {
  readonly execution: SubagentExecution;
  readonly workspace: SubagentWorkspace;
  readonly identity: SubagentIdentity;
}

export interface PlatformCapabilities {
  behavior: BehaviorBindings;
  environment: EnvironmentCapabilities;
  loopControl: LoopControl;
  /** How many sub-agents a harness can run (W0). */
  subagentExecution: SubagentExecution;
  /** Whether each sub-agent can get its own cwd/worktree (W0). */
  subagentWorkspace: SubagentWorkspace;
  /** Whether sub-agents share the parent session identity (W0). */
  subagentIdentity: SubagentIdentity;
  evidence: {
    verifiedAt: string;
    verifiedBy: string;
    notes?: string;
  };
}

type BasePlatformCapabilities = Omit<
  PlatformCapabilities,
  "subagentExecution" | "subagentWorkspace" | "subagentIdentity"
>;

/**
 * W0 values (`capability-report.md` §2, §7.2).
 *
 * - Claude Code: nested / per-task / shared (schema + docs; live run pending)
 * - Codex: parallel / inherited / isolated (docs + spawn.rs + config)
 * - ZCode: parallel / inherited / isolated (runtime-verified 3.16.3)
 * - `subagentContext.kind === "none"`: none / none / none
 * - everything else: unknown until Phase 0 verifies it
 */
const SUBAGENT_UNKNOWN: SubagentCapabilities = {
  execution: "unknown",
  workspace: "unknown",
  identity: "unknown",
};
const SUBAGENT_NONE: SubagentCapabilities = {
  execution: "none",
  workspace: "none",
  identity: "none",
};

export const SUBAGENT_CAPABILITIES: Record<PlatformId, SubagentCapabilities> = {
  "claude-code": { execution: "nested", workspace: "per-task", identity: "shared" },
  cursor: SUBAGENT_UNKNOWN,
  opencode: SUBAGENT_UNKNOWN,
  codex: { execution: "parallel", workspace: "inherited", identity: "isolated" },
  kilo: SUBAGENT_NONE,
  kiro: SUBAGENT_UNKNOWN,
  gemini: SUBAGENT_NONE,
  antigravity: SUBAGENT_NONE,
  devin: SUBAGENT_NONE,
  qoder: SUBAGENT_NONE,
  codebuddy: SUBAGENT_UNKNOWN,
  copilot: SUBAGENT_NONE,
  droid: SUBAGENT_UNKNOWN,
  dsh: SUBAGENT_NONE,
  pi: SUBAGENT_UNKNOWN,
  reasonix: SUBAGENT_NONE,
  zcode: { execution: "parallel", workspace: "inherited", identity: "isolated" },
  trae: SUBAGENT_NONE,
  omp: SUBAGENT_UNKNOWN,
  grok: SUBAGENT_NONE,
  kimi: SUBAGENT_NONE,
  snow: SUBAGENT_UNKNOWN,
};

const hook = (event: string, detail?: string): Mechanism => ({ kind: "hook", event, detail });
const plugin = (event: string, detail?: string): Mechanism => ({ kind: "plugin", event, detail });
const extension = (event: string, detail?: string): Mechanism => ({
  kind: "extension",
  event,
  detail,
});
const config = (detail?: string): Mechanism => ({ kind: "config", detail });
const envFile = (detail?: string): Mechanism => ({ kind: "env-file", detail });
const toolPrefix = (detail?: string): Mechanism => ({ kind: "tool-prefix", detail });
const native = (detail?: string): Mechanism => ({ kind: "native", detail });
const none = (reason: string): Mechanism => ({ kind: "none", reason });

const ENV_OK: EnvironmentCapabilities = {
  gitRepo: "supported",
  gitRemote: "supported",
  symlinks: "supported",
};

const evidence = (notes: string): PlatformCapabilities["evidence"] => ({
  verifiedAt: "2026-10-21",
  verifiedBy: "B1 capability audit",
  notes,
});

const BASE_CAPABILITIES = {
  "claude-code": {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: hook("PreToolUse:Task|Agent"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: envFile("CLAUDE_ENV_FILE"),
      agentDefinitions: native(".claude/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("reference platform"),
  },
  cursor: {
    behavior: {
      sessionStart: hook("sessionStart"),
      subagentContext: hook("preToolUse:Task|Subagent"),
      workflowState: none("Cursor exposes no per-turn hook; pull-based continue is the fallback"),
      shellIdentity: hook("beforeShellExecution ticket"),
      agentDefinitions: native(".cursor/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("no UserPromptSubmit equivalent"),
  },
  opencode: {
    behavior: {
      sessionStart: plugin("experimental.chat.messages.transform"),
      subagentContext: plugin("tool.execute.before"),
      workflowState: plugin("experimental.chat.messages.transform"),
      shellIdentity: toolPrefix("TRELLIS_CONTEXT_ID command prefix"),
      agentDefinitions: native(".opencode/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("v1 plugin API; v2 shard pending"),
  },
  codex: {
    behavior: {
      sessionStart: none("Codex has no SessionStart hook; skills + developer_instructions are the floor"),
      subagentContext: hook("SubagentStart"),
      workflowState: hook("UserPromptSubmit", "inline breadcrumb variant"),
      shellIdentity: none("shell children do not inherit a session id"),
      agentDefinitions: native(".codex/agents TOML"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("inline dispatch mode uses -inline breadcrumbs"),
  },
  kilo: {
    behavior: {
      sessionStart: none("class-2 workflows/skills only"),
      subagentContext: none("no sub-agent surface"),
      workflowState: none("no per-turn hook"),
      shellIdentity: none("no hook bridge"),
      agentDefinitions: none("no agent definitions"),
    },
    environment: ENV_OK,
    loopControl: "none",
    evidence: evidence("skills-only host"),
  },
  kiro: {
    behavior: {
      sessionStart: hook("agentSpawn", "plain-text stdout"),
      subagentContext: hook("agentSpawn"),
      workflowState: hook("userPromptSubmit + IDE .kiro.hook"),
      shellIdentity: none("no shell identity bridge"),
      agentDefinitions: native(".kiro/agents JSON"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("Kiro consumes plain text, not JSON envelopes"),
  },
  gemini: {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: none("class-2; no PreToolUse prompt mutation"),
      workflowState: hook("BeforeAgent"),
      shellIdentity: hook("BeforeTool ticket"),
      agentDefinitions: native(".gemini/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("sub-agent context is pull-based"),
  },
  antigravity: {
    behavior: {
      sessionStart: none("workflows and skills only"),
      subagentContext: none("no sub-agent surface"),
      workflowState: none("no per-turn hook"),
      shellIdentity: none("no hook bridge"),
      agentDefinitions: none("no agent definitions"),
    },
    environment: ENV_OK,
    loopControl: "none",
    evidence: evidence("workflow files only"),
  },
  devin: {
    behavior: {
      sessionStart: none("workflows and skills only"),
      subagentContext: none("no sub-agent prompt mutation"),
      workflowState: none("no per-turn hook"),
      shellIdentity: none("no hook bridge"),
      agentDefinitions: none("no agent definitions"),
    },
    environment: ENV_OK,
    loopControl: "none",
    evidence: evidence("pull-based workflows"),
  },
  qoder: {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: none("class-2: no sub-agent prompt mutation surface"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: hook("ticket"),
      agentDefinitions: native(".qoder/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("session hook + per-turn hook, no prompt mutation"),
  },
  codebuddy: {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: hook("PreToolUse"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: hook("ticket"),
      agentDefinitions: native(".codebuddy/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("class-1"),
  },
  copilot: {
    behavior: {
      sessionStart: hook("sessionStart"),
      subagentContext: none("class-2; no sub-agent prompt mutation"),
      workflowState: hook("userPromptSubmitted"),
      shellIdentity: none("no shell identity bridge"),
      agentDefinitions: native(".github/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("own session-start copy until B3 unification"),
  },
  droid: {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: hook("PreToolUse"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: hook("ticket"),
      agentDefinitions: native(".factory/droids"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("class-1"),
  },
  dsh: {
    behavior: {
      sessionStart: none("pull-based; default profiles have no hooks"),
      subagentContext: none("the loop itself injects context"),
      workflowState: none("loop owns the turn"),
      shellIdentity: none("loop owns the shell"),
      agentDefinitions: native("skills"),
    },
    environment: ENV_OK,
    loopControl: "full",
    evidence: evidence("custom loop host; rule-gate reference implementation"),
  },
  pi: {
    behavior: {
      sessionStart: extension("before_agent_start"),
      subagentContext: extension("tool_call"),
      workflowState: extension("before_agent_start"),
      shellIdentity: extension("tool_call prefix"),
      agentDefinitions: native(".pi/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("project-local TS extension"),
  },
  reasonix: {
    behavior: {
      sessionStart: none("skills-only"),
      subagentContext: none("no prompt mutation"),
      workflowState: none("no per-turn hook"),
      shellIdentity: none("no hook bridge"),
      agentDefinitions: native(".reasonix/agents"),
    },
    environment: ENV_OK,
    loopControl: "none",
    evidence: evidence("pull-based skills"),
  },
  zcode: {
    behavior: {
      sessionStart: config("project-hooks | bridge | prelude"),
      subagentContext: hook("PreToolUse:Agent|Task"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: hook("ticket"),
      agentDefinitions: native(".zcode/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("three-path selection is runtime; see B7"),
  },
  trae: {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: none("class-2: no sub-agent prompt mutation surface"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: hook("ticket"),
      agentDefinitions: native(".trae/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("no sub-agent prompt mutation"),
  },
  omp: {
    behavior: {
      sessionStart: extension("session start"),
      subagentContext: extension("tool hook"),
      workflowState: extension("turn start"),
      shellIdentity: extension("tool hook"),
      agentDefinitions: native(".omp/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("project-local extension"),
  },
  grok: {
    behavior: {
      sessionStart: none("hook stdout is not consumed by the model"),
      subagentContext: none("class-2: no sub-agent prompt mutation surface"),
      workflowState: none("hook stdout is not consumed"),
      shellIdentity: none("no hook bridge"),
      agentDefinitions: native(".grok/agents"),
    },
    environment: ENV_OK,
    loopControl: "none",
    evidence: evidence("Phase 0 verified 0.2.101"),
  },
  kimi: {
    behavior: {
      sessionStart: none("no project-level hook; user-level config.toml only"),
      subagentContext: none("class-2: no sub-agent prompt mutation surface"),
      workflowState: none("no per-turn hook"),
      shellIdentity: none("no hook bridge"),
      agentDefinitions: native(".kimi-code/agents"),
    },
    environment: ENV_OK,
    loopControl: "none",
    evidence: evidence("skills + custom sub-agents"),
  },
  snow: {
    behavior: {
      sessionStart: hook("SessionStart", "own hook"),
      subagentContext: hook("sub-agent hook"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: none("no shell identity bridge"),
      agentDefinitions: native(".snow/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("class-1; own context writer"),
  },
} satisfies Record<PlatformId, BasePlatformCapabilities>;

/**
 * The public matrix: every platform entry carries both the historical
 * behaviour bindings and the W0 sub-agent dimensions. Keeping the merge in one
 * place makes "new platform forgot the coordinator fields" a type error.
 */
export const CAPABILITIES: Record<PlatformId, PlatformCapabilities> = Object.fromEntries(
  PLATFORM_IDS.map((id) => {
    const subagent = SUBAGENT_CAPABILITIES[id];
    return [
      id,
      {
        ...BASE_CAPABILITIES[id],
        subagentExecution: subagent.execution,
        subagentWorkspace: subagent.workspace,
        subagentIdentity: subagent.identity,
      },
    ];
  }),
) as Record<PlatformId, PlatformCapabilities>;

export interface MatrixViolation {
  platform: string;
  message: string;
}

/** Tool names a platform generation exposes for the three behaviours core
 * needs to recognise. Kept separate from `BehaviorBindings` so the context
 * handlers can normalize `bash`/`shell`, `task`/`subagent`, and the edit
 * family without hard-coding per-platform strings. */
export interface ToolNameProfile {
  shell: readonly string[];
  subagent: readonly string[];
  edit: readonly string[];
}

const DEFAULT_TOOL_NAMES: ToolNameProfile = {
  shell: ["bash", "shell"],
  subagent: ["task", "agent", "subagent"],
  edit: [
    "write",
    "edit",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit",
    "applypatch",
    "apply_patch",
    "patch",
  ],
};

interface AdapterCapabilityOverride {
  behavior?: Partial<BehaviorBindings>;
  toolNames?: Partial<ToolNameProfile>;
  evidence?: PlatformCapabilities["evidence"];
}

/**
 * Per-generation overrides. A platform without an entry keeps its historical
 * profile, so adding a shard never changes the other twenty platforms.
 */
const ADAPTER_CAPABILITY_OVERRIDES: Record<string, AdapterCapabilityOverride> = {
  "opencode@v2": {
    behavior: {
      sessionStart: plugin("session.hook context"),
      subagentContext: plugin("tool.hook execute.before"),
      workflowState: plugin("session.hook context"),
      shellIdentity: config("env OPENCODE_SESSION_ID"),
      agentDefinitions: native(".opencode/agents"),
    },
    toolNames: {
      shell: ["shell"],
      subagent: ["subagent"],
      edit: ["write", "edit", "patch"],
    },
    evidence: {
      verifiedAt: "2026-10-28",
      verifiedBy: "opencode v2 source audit",
      notes: "@opencode/plugin 2.x; session context hook; shell env identity",
    },
  },
};

export interface AdapterCapabilityProfile extends PlatformCapabilities {
  toolNames: ToolNameProfile;
}

/**
 * Resolve the capability profile for a platform generation. Unknown or
 * omitted adapter ids return the platform's historical profile, which keeps
 * every pre-existing consumer working unchanged.
 */
export function capabilitiesFor(
  platform: PlatformId,
  adapterId?: string | null,
): AdapterCapabilityProfile {
  const base = CAPABILITIES[platform];
  const override = adapterId ? ADAPTER_CAPABILITY_OVERRIDES[adapterId] : undefined;
  return {
    ...base,
    behavior: { ...base.behavior, ...(override?.behavior ?? {}) },
    toolNames: { ...DEFAULT_TOOL_NAMES, ...(override?.toolNames ?? {}) },
    evidence: override?.evidence ?? base.evidence,
  };
}

export function validateCapabilities(): MatrixViolation[] {
  const violations: MatrixViolation[] = [];
  for (const id of PLATFORM_IDS) {
    const capabilities = CAPABILITIES[id];
    if (!capabilities) {
      violations.push({ platform: id, message: "missing capability entry" });
      continue;
    }
    for (const [name, mechanism] of Object.entries(capabilities.behavior)) {
      if (mechanism.kind === "none" && mechanism.reason.trim().length < 10) {
        violations.push({
          platform: id,
          message: `${name}: none requires a reason of at least 10 characters`,
        });
      }
    }
  }
  return violations;
}
