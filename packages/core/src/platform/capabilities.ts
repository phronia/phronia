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

export interface PlatformCapabilities {
  behavior: BehaviorBindings;
  environment: EnvironmentCapabilities;
  loopControl: LoopControl;
  evidence: {
    verifiedAt: string;
    verifiedBy: string;
    notes?: string;
  };
}

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

export const CAPABILITIES: Record<PlatformId, PlatformCapabilities> = {
  "claude-code": {
    behavior: {
      sessionStart: hook("SessionStart"),
      subagentContext: hook("PreToolUse:Task|Agent"),
      workflowState: hook("UserPromptSubmit"),
      shellIdentity: envFile("CLAUDE_ENV_FILE"),
      agentDefinitions: hook("native .claude/agents"),
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
      agentDefinitions: hook("native .cursor/agents"),
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
      agentDefinitions: hook("native .opencode/agents"),
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
      agentDefinitions: hook("native .codex/agents TOML"),
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
      agentDefinitions: hook("native .kiro/agents JSON"),
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
      agentDefinitions: hook("native .gemini/agents"),
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
      agentDefinitions: hook("native .qoder/agents"),
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
      agentDefinitions: hook("native .codebuddy/agents"),
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
      agentDefinitions: hook("native .github/agents"),
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
      agentDefinitions: hook("native .factory/droids"),
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
      agentDefinitions: hook("native skills"),
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
      agentDefinitions: hook("native .pi/agents"),
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
      agentDefinitions: hook("native .reasonix/agents"),
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
      agentDefinitions: hook("native .zcode/agents"),
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
      agentDefinitions: hook("native .trae/agents"),
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
      agentDefinitions: hook("native .omp/agents"),
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
      agentDefinitions: hook("native .grok/agents"),
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
      agentDefinitions: hook("native .kimi-code/agents"),
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
      agentDefinitions: hook("native .snow/agents"),
    },
    environment: ENV_OK,
    loopControl: "hooks",
    evidence: evidence("class-1; own context writer"),
  },
};

export interface MatrixViolation {
  platform: string;
  message: string;
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
