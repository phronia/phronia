import { describe, expect, it } from "vitest";
import {
  ContextContractError,
  contextJsonSchema,
  handleContext,
  renderContext,
} from "../../src/context/index.js";
import type { ContextRequest } from "../../src/context/types.js";

const BASE: ContextRequest = {
  schemaVersion: 1,
  event: "session-start",
  platform: { id: "claude-code" },
  projectRoot: "/definitely/missing",
  input: {},
  env: {},
};

describe("context contract", () => {
  it("rejects an unknown schema version", () => {
    expect(() =>
      handleContext({ ...BASE, schemaVersion: 2 as never }),
    ).toThrow(ContextContractError);
  });

  it("returns an explicit diagnostic for unimplemented events", () => {
    const response = handleContext({ ...BASE, event: "session-end" });
    expect(response.degraded).toBe(true);
    expect(response.diagnostics.map((item) => item.code)).toContain(
      "context.event_not_implemented",
    );
  });

  it("degrades outside a Phronia project instead of throwing", () => {
    const response = handleContext(BASE);
    expect(response.degraded).toBe(true);
    expect(response.blocks.map((block) => block.id)).toContain("task-status");
    expect(response.session.key).toBeNull();
  });

  it("renders Claude, ZCode, and Kiro envelopes", () => {
    const response = handleContext(BASE);
    const claude = JSON.parse(renderContext(response)) as {
      hookSpecificOutput: { additionalContext: string };
      additional_context: string;
    };
    expect(claude.additional_context).toBe(
      claude.hookSpecificOutput.additionalContext,
    );

    const zcode = JSON.parse(renderContext(response, { envelope: "zcode-hook-v1" })) as {
      additional_context?: string;
    };
    expect(zcode.additional_context).toBeUndefined();

    const kiro = renderContext(response, { envelope: "kiro-plain" });
    expect(kiro.startsWith("<session-context>")).toBe(true);
  });

  it("publishes request and response schemas", () => {
    const schema = contextJsonSchema() as {
      request: { required: string[] };
      response: { required: string[] };
    };
    expect(schema.request.required).toContain("schemaVersion");
    expect(schema.response.required).toContain("blocks");
  });
});
