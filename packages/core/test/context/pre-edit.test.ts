import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPreEdit } from "../../src/context/pre-edit.js";
import { RULES_END, RULES_START } from "../../src/rules/index.js";
import type { ContextRequest } from "../../src/context/types.js";

const RULES = `${RULES_START}
| ID | Rule | Scope | Severity | Check | Fix | Status | Rationale |
|---|---|---|---|---|---|---|---|
| CLI-001 | Use atomic writes | packages/cli/src/** | critical | auto | mechanical | verified | fs-safety |
| CLI-002 | Draft only | packages/cli/src/** | high | agent | report | draft | draft-rule |
| CLI-003 | Unrelated | docs/** | high | report | report | verified | docs |
${RULES_END}
`;

describe("pre-edit rule injection", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-pre-edit-"));
    const spec = path.join(root, ".phronia/spec/cli/backend");
    fs.mkdirSync(spec, { recursive: true });
    fs.writeFileSync(path.join(spec, "rules.md"), RULES);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("injects verified rules matching the edited path", () => {
    const response = buildPreEdit(preEditRequest(root, { file_path: "packages/cli/src/configurators/new.ts" }));
    const text = response.blocks[0]?.text ?? "";
    expect(text).toContain("<rules-for-path");
    expect(text).toContain("[CLI-001]");
    expect(text).not.toContain("CLI-002");
    expect(text).not.toContain("CLI-003");
  });

  it("returns no block when no rule matches", () => {
    const response = buildPreEdit(preEditRequest(root, { file_path: "README.md" }));
    expect(response.blocks).toEqual([]);
  });

  it("accepts an absolute path", () => {
    const response = buildPreEdit(
      preEditRequest(root, { path: path.join(root, "packages/cli/src/a.ts") }),
    );
    expect(response.blocks[0]?.text).toContain("[CLI-001]");
  });
});

function preEditRequest(root: string, toolInput: Record<string, string>): ContextRequest {
  return {
    schemaVersion: 1,
    event: "pre-tool-use",
    platform: { id: "claude-code" },
    projectRoot: root,
    input: { tool_name: "Edit", tool_input: toolInput },
  };
}
