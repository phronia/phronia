/**
 * Harness-neutral context contract (schemaVersion 1).
 *
 * Core returns a plan — ordered blocks, semantic mutations, shim effects —
 * never a harness envelope. Shims render the envelope from the `envelope` key.
 */

import type { PlatformId } from "../platform/ids.js";
import type { Diagnostic } from "../state/diagnostics.js";

export const CONTEXT_SCHEMA_VERSION = 1 as const;

export type ContextEvent =
  | "session-start"
  | "user-prompt"
  | "pre-tool-use"
  | "pre-shell"
  | "subagent-spawn"
  | "session-end";

export interface ContextRequest {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  event: ContextEvent;
  platform: {
    id: PlatformId;
    harnessVersion?: string | null;
    adapterId?: string | null;
  };
  /** Explicit project root. The core never infers it from cwd. */
  projectRoot: string;
  /** Raw harness payload, passed through unchanged. */
  input: unknown;
  /** Test/embedding override; defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  hints?: {
    sessionId?: string;
    /** Parent harness session, when a child-agent session is dispatched. */
    parentSessionId?: string;
    /** Adapter id observed by the shim; `platform.adapterId` is preferred. */
    adapterId?: string;
    conversationId?: string;
    transcriptPath?: string;
    toolName?: string;
    agentType?: string;
    prompt?: string;
    /** Return materialized context without the agent-role prompt wrapper. */
    contextOnly?: boolean;
    /** Explicit task reference from the harness; wins over session state. */
    taskRef?: string;
    /** Defaults to true for sub-agent dispatch; native hosts may opt out. */
    allowSingleSessionFallback?: boolean;
    cwd?: string;
    filePath?: string;
    hasAssistantMessages?: boolean;
  };
  options?: {
    failurePolicy?: FailurePolicy;
    planOnly?: boolean;
    disableBlocks?: string[];
    /** Pre-computed update hint (the CLI owns the version probe). */
    updateHint?: string | null;
    /** Test hook: epoch seconds for ticket freshness. */
    now?: number;
  };
}

export type FailurePolicy = "degrade" | "silent-ok" | "fail-loud" | "disabled";

export interface ContextBlock {
  id: string;
  text: string;
  /** 0 = never trim; larger values are dropped first under budget pressure. */
  priority: number;
  oncePerSession?: boolean;
  source?: { kind: "spec" | "task" | "workflow" | "system"; ref?: string };
}

export type Mutation =
  | { op: "set-prompt"; value: string; marker: string }
  | { op: "prepend-prompt"; value: string; marker: string }
  | { op: "set-env"; name: string; value: string };

export type Effect =
  | { type: "marker"; path: string; content: string; ifAbsent: boolean }
  | { type: "env-export"; file: string; line: string }
  | { type: "shell-ticket"; path: string; content: string; ttlSeconds: number };

export interface ContextResponse {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  coreVersion: string;
  event: ContextEvent;
  platform: PlatformId;
  projectRoot: string;
  session: {
    key: string | null;
    keySource: string;
    task: string | null;
    taskSource: string;
    taskStale: boolean;
  };
  blocks: ContextBlock[];
  mutations: Mutation[];
  effects: Effect[];
  envelope: string;
  degraded: boolean;
  diagnostics: Diagnostic[];
}

export interface ContextRenderResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}
