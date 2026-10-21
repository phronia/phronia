/**
 * Feature → capability requirements.
 *
 * `doctor` uses this table to explain why a feature is unavailable instead of
 * leaving the user with a silent no-op.
 */

import { CAPABILITIES, type PlatformCapabilities } from "./capabilities.js";
import type { PlatformId } from "./ids.js";

export type FeatureId =
  | "context.sessionStart"
  | "context.subagent"
  | "context.workflowState"
  | "task.branch"
  | "task.worktree"
  | "crossRepo.task"
  | "rules.gate";

export interface FeatureStatus {
  id: FeatureId;
  available: boolean;
  reason?: string;
}

export function featureStatus(
  platform: PlatformId,
  feature: FeatureId,
): FeatureStatus {
  const capabilities = CAPABILITIES[platform];
  const reason = missingRequirement(capabilities, feature);
  return reason
    ? { id: feature, available: false, reason }
    : { id: feature, available: true };
}

function missingRequirement(
  capabilities: PlatformCapabilities,
  feature: FeatureId,
): string | null {
  const behavior = capabilities.behavior;
  const environment = capabilities.environment;
  switch (feature) {
    case "context.sessionStart":
      return behavior.sessionStart.kind === "none"
        ? `sessionStart: ${behavior.sessionStart.reason}`
        : null;
    case "context.subagent":
      return behavior.subagentContext.kind === "none"
        ? `subagentContext: ${behavior.subagentContext.reason}`
        : null;
    case "context.workflowState":
      return behavior.workflowState.kind === "none"
        ? `workflowState: ${behavior.workflowState.reason}`
        : null;
    case "task.branch":
      return environment.gitRepo === "unsupported"
        ? "gitRepo is unsupported for this environment"
        : null;
    case "task.worktree":
      if (environment.gitRepo === "unsupported") {
        return "gitRepo is unsupported for this environment";
      }
      return environment.symlinks === "unsupported"
        ? "symlinks are unsupported for this environment"
        : null;
    case "crossRepo.task":
      return environment.gitRemote === "unsupported"
        ? "gitRemote is unsupported for this environment"
        : null;
    case "rules.gate":
      return capabilities.loopControl === "full"
        ? null
        : "requires loopControl: full";
  }
}
