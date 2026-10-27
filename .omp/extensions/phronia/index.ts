// phronia-shim: omp@v1
// shim-version: 0.6.17
// DO NOT EDIT. Regenerate with: phronia update --regenerate-shims
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

function findProjectRoot(startDir: string): string | null {
   let current = startDir;
   while (true) {
      if (existsSync(join(current, ".phronia"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
   }
   return null;
}

// ---------------------------------------------------------------------------
// Session identity
//
// The host owns the session id; core owns the runtime-file naming contract.
// Only the host half lives here.
// ---------------------------------------------------------------------------

function sanitizeKey(raw: string): string {
   const safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
   return safe ? safe.slice(0, 160) : "";
}

function hashValue(raw: string): string {
   return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function buildContextKey(platformName: string, kind: string, value: string): string {
   if (kind === "transcript") {
      return `${platformName}_transcript_${hashValue(value)}`;
   }
   const safeValue = sanitizeKey(value);
   return safeValue ? `${platformName}_${safeValue}` : `${platformName}_${hashValue(value)}`;
}

function deriveContextKey(ctx?: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): string | null {
   const sessionId = ctx?.sessionManager?.getSessionId?.();
   if (sessionId) {
      return buildContextKey("omp", "session", sessionId);
   }
   const sessionFile = ctx?.sessionManager?.getSessionFile?.();
   if (sessionFile) {
      return buildContextKey("omp", "transcript", sessionFile);
   }
   const override = process.env.PHRONIA_CONTEXT_ID?.trim();
   return override ? sanitizeKey(override) || hashValue(override) : null;
}

// ---------------------------------------------------------------------------
// Core bridge
//
// Context assembly belongs to `phronia context`. This extension translates
// host events into requests and applies the returned plan.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function runCoreContext(
   root: string,
   event: string,
   input: JsonObject,
): JsonObject | null {
   const cliPath = process.env.PHRONIA_CLI_PATH;
   const command = cliPath ? process.execPath : "phronia";
   const args = cliPath ? [cliPath, "context"] : ["context"];
   args.push(
      "--event",
      event,
      "--platform",
      "omp",
      "--project-root",
      root,
      "--input",
      "-",
      "--json",
   );
   const result = spawnSync(command, args, {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      env: process.env,
   });
   if (result.status !== 0 || !result.stdout) return null;
   try {
      const parsed = JSON.parse(result.stdout);
      return parsed && typeof parsed === "object" ? (parsed as JsonObject) : null;
   } catch {
      return null;
   }
}

function blocksText(response: JsonObject | null): string {
   if (!response || !Array.isArray(response.blocks)) return "";
   return response.blocks
      .map((block) => {
         const text = (block as { text?: unknown }).text;
         return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n\n");
}

function sessionKey(response: JsonObject | null): string | null {
   const session = response?.session;
   if (!session || typeof session !== "object") return null;
   const key = (session as { key?: unknown }).key;
   return typeof key === "string" && key ? key : null;
}

// ---------------------------------------------------------------------------
// Sub-agent detection
// ---------------------------------------------------------------------------

const PHRONIA_AGENTS = new Set(["phronia-implement", "phronia-check", "phronia-research"]);

function detectAgentType(): string | null {
   const blocked = process.env.PI_BLOCKED_AGENT;
   if (blocked && PHRONIA_AGENTS.has(blocked)) {
      return blocked;
   }
   return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function(pi: ExtensionAPI): void {
   let projectRoot: string | null = null;
   let lastKey: string | null = null;
   let lastPrompt = "";
   const agentType = detectAgentType();
   const isSubAgent = agentType !== null;

   // One core round-trip per event cascade: input, before_agent_start, and
   // context fire back to back for the same prompt.
   let turnCache: { prompt: string; taskContext: string; breadcrumb: string } | null = null;

   const oneShot = (root: string, sessionId: string | undefined): JsonObject | null => {
      const response = runCoreContext(root, "session-start", sessionId ? { session_id: sessionId } : {});
      lastKey = sessionKey(response) ?? lastKey;
      return response;
   };

   const taskContextFor = (root: string, sessionId: string | undefined): string => {
      const response = runCoreContext(root, "subagent-spawn", {
         ...(sessionId ? { session_id: sessionId } : {}),
         subagent_type: agentType ?? "session",
         context_only: true,
      });
      lastKey = sessionKey(response) ?? lastKey;
      const text = blocksText(response);
      return text ? `<task-context>\n${text}\n</task-context>` : "";
   };

   const turnContext = (
      root: string,
      sessionId: string | undefined,
   ): { taskContext: string; breadcrumb: string } => {
      if (turnCache && turnCache.prompt === lastPrompt) {
         return turnCache;
      }
      const promptResponse = runCoreContext(root, "user-prompt", {
         ...(sessionId ? { session_id: sessionId } : {}),
         prompt: lastPrompt,
      });
      lastKey = sessionKey(promptResponse) ?? lastKey;
      turnCache = {
         prompt: lastPrompt,
         taskContext: taskContextFor(root, sessionId),
         breadcrumb: blocksText(promptResponse),
      };
      return turnCache;
   };

   const sessionIdOf = (ctx?: { sessionManager?: { getSessionId?: () => string | undefined } }): string | undefined =>
      ctx?.sessionManager?.getSessionId?.();

   pi.on("session_start", async (_event, ctx) => {
      projectRoot = findProjectRoot(ctx.cwd);
      if (!projectRoot) return;
      const sessionId = sessionIdOf(ctx);

      if (isSubAgent) {
         const taskContext = taskContextFor(projectRoot, sessionId);
         if (taskContext) {
            await pi.sendMessage({
               customType: "phronia-task-context",
               content: taskContext,
               display: false,
            });
         }
         return;
      }

      const sessionContext = blocksText(oneShot(projectRoot, sessionId));
      if (sessionContext) {
         await pi.sendMessage({
            customType: "phronia-session-context",
            content: sessionContext,
            display: false,
         });
      }

      // Main session sees both curated manifests plus every task artifact.
      const taskContext = taskContextFor(projectRoot, sessionId);
      if (taskContext) {
         await pi.sendMessage({
            customType: "phronia-task-context",
            content: taskContext,
            display: false,
         });
      }

      ctx.ui.notify("Phronia workflow system available", "info");
   });

   // Tracks compaction boundaries — the context handler only re-scans when
   // persisted context may have been dropped.
   let lastCompactionTs = 0;
   let lastInjectionTs = 0;

   pi.on("session_before_compact", async () => {
      lastCompactionTs = Date.now();
   });

   pi.on("before_agent_start", async (event, ctx) => {
      if (!projectRoot) {
         projectRoot = findProjectRoot(ctx.cwd);
      }
      if (!projectRoot) return;
      const prompt = (event as { prompt?: unknown }).prompt;
      if (typeof prompt === "string") lastPrompt = prompt;

      const { breadcrumb } = turnContext(projectRoot, sessionIdOf(ctx));
      lastInjectionTs = Date.now();
      if (!breadcrumb) return;

      return {
         message: {
            customType: "phronia-workflow-state",
            content: breadcrumb,
            display: false,
         },
      };
   });

   // context fires before EVERY LLM API call (including tool-use continuations
   // and post-compaction agent.continue() paths). Acts as a safety net when
   // before_agent_start's persisted message was removed by compaction.
   pi.on("context", async (event, ctx) => {
      if (!projectRoot) return;
      const sessionId = sessionIdOf(ctx);
      const { taskContext, breadcrumb } = turnContext(projectRoot, sessionId);

      const messages = event.messages as { role?: string; customType?: string; content?: string }[];
      const taskContextIndexes = messages
         .map((message, index) => message.customType === "phronia-task-context" ? index : -1)
         .filter((index) => index >= 0);
      const existingTaskContext = taskContextIndexes.length > 0
         ? messages[taskContextIndexes[0]]?.content ?? ""
         : "";
      const taskContextChanged = existingTaskContext !== taskContext || taskContextIndexes.length > 1;
      let projectedMessages = messages;
      if (taskContextChanged) {
         const replacement = taskContext
            ? { role: "custom" as const, customType: "phronia-task-context", content: taskContext, display: false, timestamp: Date.now() }
            : null;
         let replaced = false;
         projectedMessages = messages.flatMap((message) => {
            if (message.customType !== "phronia-task-context") return [message];
            if (replaced || !replacement) return [];
            replaced = true;
            return [replacement];
         });
         if (replacement && !replaced) projectedMessages.push(replacement);
      }

      // A skip turn must still run breadcrumb cleanup even when nothing else
      // changed.
      const skipping = !breadcrumb;

      // Fast path: no task change, no compaction, not skipping — all persisted
      // context is current.
      if (!taskContextChanged && !skipping && lastInjectionTs > lastCompactionTs) return;

      if (skipping) {
         // Drop any persisted breadcrumb from an earlier turn so the skip
         // actually takes effect.
         const withoutBreadcrumb = projectedMessages.filter(
            (message) => !(message.role === "custom" && message.customType === "phronia-workflow-state"),
         );
         if (withoutBreadcrumb.length === projectedMessages.length && !taskContextChanged) return;
         lastInjectionTs = Date.now();
         return { messages: withoutBreadcrumb };
      }

      // Post-compaction: reverse-scan to confirm absence before injecting.
      for (let i = projectedMessages.length - 1; i >= 0; i--) {
         if (projectedMessages[i].role === "custom" && projectedMessages[i].customType === "phronia-workflow-state") {
            lastInjectionTs = Date.now();
            return taskContextChanged ? { messages: projectedMessages } : undefined;
         }
      }

      lastInjectionTs = Date.now();
      return {
         messages: [
            ...projectedMessages,
            {
               role: "custom" as const,
               customType: "phronia-workflow-state",
               content: breadcrumb,
               display: false,
               timestamp: Date.now(),
            },
         ],
      };
   });

   // OMP passes Bash event.input through to the tool execution parameters, so
   // inject the session key through the shell-agnostic env field. An explicit
   // per-call value wins over the derived key.
   pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      const contextKey = lastKey ?? deriveContextKey(ctx);
      if (!contextKey) return;
      const input = event.input as { env?: Record<string, string> };
      input.env = {
         PHRONIA_CONTEXT_ID: contextKey,
         ...input.env,
      };
   });

   pi.on("input", async (event, ctx) => {
      if (!projectRoot) {
         projectRoot = findProjectRoot(ctx.cwd);
      }
      if (!projectRoot) return;
      const text = (event as { text?: unknown }).text;
      lastPrompt = typeof text === "string" ? text : "";
      // New turn: every reader in the cascade must recompute from this prompt.
      turnCache = null;
   });
}
