/**
 * Turn a factual `DispatchVerdict` into an enforceable outcome (design.md §6.4,
 * §7).
 *
 * The policy answers "is this dispatch factually allowed?"; this module answers
 * "what can this platform actually do about it?". Downgrading is never silent:
 * every non-deny outcome carries a diagnostic, and a platform that cannot block
 * gets a guard block whose first line is a stop instruction.
 */

import type {
  HookPolicy,
  SubagentWorkspace,
} from "../../platform/capabilities.js";
import type { PlatformId } from "../../platform/ids.js";
import {
  diagnostic,
  type Diagnostic,
} from "../../state/diagnostics.js";
import type { DenyMutation } from "../types.js";
import type {
  ClaimFacts,
  DispatchEnforce,
  DispatchVerdict,
  GuardBlock,
  LeaseFacts,
} from "../../task/dispatch/types.js";

export interface EnforcementOptions {
  readonly hookPolicy: HookPolicy;
  readonly enforce: DispatchEnforce;
  /** Included in the "cannot block" guard and diagnostic. */
  readonly platformId?: PlatformId;
  readonly subagentWorkspace?: SubagentWorkspace;
}

export interface EnforcementResult {
  readonly deny?: DenyMutation;
  readonly guard?: GuardBlock;
  readonly diagnostics: readonly Diagnostic[];
}

export function applyEnforcement(
  verdict: DispatchVerdict,
  options: EnforcementOptions,
): EnforcementResult {
  const diagnostics: Diagnostic[] = [];

  // `off` disables admission entirely: no deny and no guard, even for an
  // allow-time advisory. The diagnostic keeps the downgrade observable.
  if (options.enforce === "off") {
    if (verdict.decision === "block" || verdict.guard !== null) {
      diagnostics.push(
        diagnostic(
          "DISPATCH_ENFORCE_OFF",
          "info",
          `admission disabled (parallel.dispatch.enforce=off); ${verdict.code} was not enforced`,
          { details: { code: verdict.code } },
        ),
      );
    }
    return { diagnostics };
  }

  if (verdict.decision === "block") {
    if (options.enforce === "warn") {
      diagnostics.push(
        diagnostic(
          "DISPATCH_ENFORCE_WARN",
          "warn",
          `parallel.dispatch.enforce=warn; ${verdict.code} is advisory`,
          { details: { code: verdict.code } },
        ),
      );
      return {
        guard: {
          code: verdict.code,
          severity: "error",
          lines: [
            ...factLines(verdict),
            "enforcement: parallel.dispatch.enforce=warn",
          ],
        },
        diagnostics,
      };
    }

    if (options.hookPolicy === "block") {
      return {
        deny: {
          op: "deny",
          code: verdict.code,
          reason: verdict.reason,
          next: verdict.next,
        },
        diagnostics,
      };
    }

    diagnostics.push(
      diagnostic(
        "DISPATCH_PLATFORM_CANNOT_BLOCK",
        "warn",
        `platform ${options.platformId ?? "unknown"} (hookPolicy=${options.hookPolicy}) cannot block a dispatch; ${verdict.code} was downgraded to a guard`,
        { details: { code: verdict.code, hookPolicy: options.hookPolicy } },
      ),
    );
    return {
      guard: {
        code: verdict.code,
        severity: "error",
        lines: guardLines(verdict, options),
      },
      diagnostics,
    };
  }

  // Allow: the policy may already carry an advisory guard. Never add a guard
  // for the two informational outcomes; they are not workspace risks.
  if (
    verdict.guard !== null &&
    verdict.code !== "DISPATCH_NO_ACTIVE_TASK" &&
    verdict.code !== "DISPATCH_OUTSIDE_CONTRACT"
  ) {
    return {
      guard: { ...verdict.guard, severity: "warn" },
      diagnostics,
    };
  }
  return { diagnostics };
}

export function renderGuard(block: GuardBlock): string {
  return [
    `<workspace-guard code="${block.code}" severity="${block.severity}">`,
    ...block.lines,
    "</workspace-guard>",
  ].join("\n");
}

/** Self-contained text for a deny delivered as a tool error (ZCode/Claude). */
export function renderDenyReason(verdict: DispatchVerdict): string {
  return denyReason(verdict.code, verdict.reason, verdict.next);
}

function denyReason(
  code: string,
  reason: string,
  next: readonly string[],
): string {
  const lines = [`${code}: ${reason}`];
  if (next.length > 0) {
    lines.push("Next:");
    next.forEach((command, index) => {
      lines.push(`${index + 1}. ${command}`);
    });
  }
  lines.push("Do not retry; report this exactly.");
  return lines.join("\n");
}

/**
 * Guard for a blocked verdict on a platform that cannot block. The child may
 * already be running (Codex `SubagentStart`), so the first line must stop it
 * rather than advise it.
 */
function guardLines(
  verdict: DispatchVerdict,
  options: EnforcementOptions,
): readonly string[] {
  const lines = [
    "STOP: do not edit any file until the workspace contract is satisfied.",
    "You are already running in the parent checkout; report this guard to the parent session.",
    ...factLines(verdict),
    ...enforcementLines(verdict, options),
  ];
  return lines;
}

function enforcementLines(
  verdict: DispatchVerdict,
  options: EnforcementOptions,
): readonly string[] {
  const platform = options.platformId ?? "unknown";
  const workspace =
    options.subagentWorkspace === undefined
      ? ""
      : `, subagentWorkspace=${options.subagentWorkspace}`;
  const lines = [
    `platform: ${platform} (hookPolicy=${options.hookPolicy}${workspace})`,
    "this harness cannot block the dispatch; use multi-session:",
  ];
  if (verdict.next.length === 0) {
    lines.push("  1. report this guard to the parent session");
  } else {
    verdict.next.forEach((command, index) => {
      lines.push(`  ${index + 1}. ${command}`);
    });
  }
  return lines;
}

function factLines(verdict: DispatchVerdict): readonly string[] {
  const details = verdict.details as {
    effectiveTask?: unknown;
    status?: unknown;
    activeTask?: unknown;
    checkout?: { isLinkedWorktree?: unknown; root?: unknown };
    claim?: ClaimFacts | null;
    lease?: LeaseFacts | null;
    siblings?: { inProgress?: unknown; planning?: unknown } | null;
  };
  const task =
    typeof details.effectiveTask === "string" ? details.effectiveTask : null;
  const status = typeof details.status === "string" ? details.status : "unknown";
  const active =
    typeof details.activeTask === "string" ? details.activeTask : null;

  const lines: string[] = [];
  if (task !== null) {
    lines.push(`task: ${task} (${status})`);
  }
  if (active !== null && active !== task) {
    lines.push(`active: ${active}`);
  }
  lines.push(`workspace: ${workspaceLine(details)}`);
  lines.push(`claim: ${claimLine(details.claim ?? null)}`);
  lines.push(`lease: ${leaseLine(details.lease ?? null)}`);
  lines.push(`parallel: ${parallelLine(details.siblings ?? null)}`);
  lines.push(`risk: ${verdict.reason}`);
  if (verdict.next.length > 0) {
    lines.push("next:");
    verdict.next.forEach((command, index) => {
      lines.push(`  ${index + 1}. ${command}`);
    });
  }
  return lines;
}

function workspaceLine(details: {
  checkout?: { isLinkedWorktree?: unknown; root?: unknown };
  claim?: ClaimFacts | null;
}): string {
  const root =
    typeof details.checkout?.root === "string" ? details.checkout.root : null;
  if (details.checkout?.isLinkedWorktree === true) {
    return root === null ? "worktree" : `worktree ${root}`;
  }
  const claim = details.claim ?? null;
  if (claim === null) {
    return "main (unclaimed)";
  }
  const owner = claimOwner(claim);
  return claim.stale ? `main (claim stale: ${owner})` : `main (claimed by ${owner})`;
}

function claimLine(claim: ClaimFacts | null): string {
  if (claim === null) {
    return "none";
  }
  const owner = claimOwner(claim);
  return claim.stale ? `stale (${owner})` : owner;
}

function claimOwner(claim: ClaimFacts): string {
  return claim.taskRef !== null ? `task ${claim.taskRef}` : claim.ownerRef;
}

function leaseLine(lease: LeaseFacts | null): string {
  if (lease === null) {
    return "none";
  }
  const owner = `${lease.ownerType} ${lease.ownerId}`;
  return lease.stale ? `stale (${owner})` : owner;
}

function parallelLine(
  siblings: { inProgress?: unknown; planning?: unknown } | null,
): string {
  if (siblings === null) {
    return "serial";
  }
  const inProgress = typeof siblings.inProgress === "number" ? siblings.inProgress : 0;
  const planning = typeof siblings.planning === "number" ? siblings.planning : 0;
  return `${inProgress} in_progress children (planning ${planning})`;
}
