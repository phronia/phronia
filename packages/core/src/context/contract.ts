/**
 * JSON Schema for the context contract, emitted by `phronia context --schema`.
 *
 * Hand-written so `@phronia/core` stays dependency-free. It mirrors
 * `types.ts`; tests validate representative requests and responses.
 */

export function contextJsonSchema(): Record<string, unknown> {
  const mechanism = {
    type: "object",
    required: ["kind"],
    properties: {
      kind: {
        enum: [
          "hook",
          "plugin",
          "extension",
          "config",
          "prelude",
          "env-file",
          "tool-prefix",
          "none",
        ],
      },
      event: { type: "string" },
      detail: { type: "string" },
      reason: { type: "string", minLength: 10 },
    },
  };

  const request = {
    type: "object",
    required: ["schemaVersion", "event", "platform", "projectRoot", "input"],
    properties: {
      schemaVersion: { const: 1 },
      event: {
        enum: [
          "session-start",
          "user-prompt",
          "pre-tool-use",
          "pre-shell",
          "subagent-spawn",
          "session-end",
        ],
      },
      platform: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          harnessVersion: { type: ["string", "null"] },
          adapterId: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      projectRoot: { type: "string", minLength: 1 },
      input: {},
      env: { type: "object", additionalProperties: { type: "string" } },
      hints: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          parentSessionId: { type: "string" },
          adapterId: { type: "string" },
          conversationId: { type: "string" },
          transcriptPath: { type: "string" },
          toolName: { type: "string" },
          agentType: { type: "string" },
          prompt: { type: "string" },
          contextOnly: { type: "boolean" },
          taskRef: { type: "string" },
          allowSingleSessionFallback: { type: "boolean" },
          cwd: { type: "string" },
          filePath: { type: "string" },
          hasAssistantMessages: { type: "boolean" },
        },
        additionalProperties: false,
      },
      options: {
        type: "object",
        properties: {
          failurePolicy: {
            enum: ["degrade", "silent-ok", "fail-loud", "disabled"],
          },
          planOnly: { type: "boolean" },
          disableBlocks: { type: "array", items: { type: "string" } },
          updateHint: { type: ["string", "null"] },
          now: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };

  const block = {
    type: "object",
    required: ["id", "text", "priority"],
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      priority: { type: "integer", minimum: 0 },
      oncePerSession: { type: "boolean" },
      source: {
        type: "object",
        properties: {
          kind: { enum: ["spec", "task", "workflow", "system"] },
          ref: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };

  const response = {
    type: "object",
    required: [
      "schemaVersion",
      "coreVersion",
      "event",
      "platform",
      "projectRoot",
      "session",
      "blocks",
      "mutations",
      "effects",
      "envelope",
      "degraded",
      "diagnostics",
    ],
    properties: {
      schemaVersion: { const: 1 },
      coreVersion: { type: "string" },
      event: { type: "string" },
      platform: { type: "string" },
      projectRoot: { type: "string" },
      session: {
        type: "object",
        required: ["key", "keySource", "task", "taskSource", "taskStale"],
        properties: {
          key: { type: ["string", "null"] },
          keySource: { type: "string" },
          task: { type: ["string", "null"] },
          taskSource: { type: "string" },
          taskStale: { type: "boolean" },
        },
      },
      blocks: { type: "array", items: block },
      mutations: { type: "array", items: { type: "object" } },
      effects: { type: "array", items: { type: "object" } },
      envelope: { type: "string" },
      degraded: { type: "boolean" },
      diagnostics: {
        type: "array",
        items: {
          type: "object",
          required: ["code", "severity", "message"],
          properties: {
            code: { type: "string" },
            severity: { enum: ["info", "warn", "error"] },
            message: { type: "string" },
            path: { type: "string" },
            details: { type: "object" },
          },
        },
      },
    },
    additionalProperties: false,
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://phronia.dev/contracts/context-v1.json",
    title: "Phronia context contract v1",
    $defs: { mechanism, block },
    request,
    response,
  };
}
