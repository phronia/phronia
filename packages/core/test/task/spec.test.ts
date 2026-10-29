import { describe, expect, it } from "vitest";
import {
  canSync,
  isSpecOnly,
  parseSpecDelta,
  readSpecSyncState,
  resolveSpecDisplayState,
  validateSpecTargets,
  verifyChangedTargets,
} from "../../src/task/spec/policy.js";

describe("parseSpecDelta", () => {
  it("parses target files, intent, rationale, and verification bullets", () => {
    const delta = parseSpecDelta(
      [
        "# Spec Delta",
        "",
        "## Target files",
        "- `.phronia/spec/cli/backend/parallel-tasks.md`",
        "* .phronia/spec/core/index.md",
        "",
        "## Intended changes",
        "- Add the dispatch admission section.",
        "",
        "## Rationale",
        "- The module changed the public layering.",
        "",
        "## Verification",
        "- `pnpm --filter @phronia/core test`",
      ].join("\n"),
    );

    expect(delta).toEqual({
      targetFiles: [
        ".phronia/spec/cli/backend/parallel-tasks.md",
        ".phronia/spec/core/index.md",
      ],
      intent: ["Add the dispatch admission section."],
      rationale: ["The module changed the public layering."],
      verification: ["pnpm --filter @phronia/core test"],
    });
  });

  it("tolerates ### headings and numbered bullets", () => {
    const delta = parseSpecDelta(
      [
        "### Target files",
        "1. .phronia/spec/a.md",
        "### Intent",
        "2) Describe the new contract.",
      ].join("\n"),
    );
    expect(delta.targetFiles).toEqual([".phronia/spec/a.md"]);
    expect(delta.intent).toEqual(["Describe the new contract."]);
  });

  it("returns empty lists when a section is absent", () => {
    expect(parseSpecDelta("# Spec Delta\n")).toEqual({
      targetFiles: [],
      intent: [],
      rationale: [],
      verification: [],
    });
  });
});

describe("validateSpecTargets", () => {
  it("accepts repo-relative targets under .phronia/spec", () => {
    expect(
      validateSpecTargets(
        [".phronia/spec/cli/backend/a.md", ".phronia/spec/guides/b.md"],
        "/repo",
      ),
    ).toEqual({ ok: true, root: "/repo", invalid: [] });
  });

  it("rejects absolute paths, '..', and paths outside .phronia/spec", () => {
    const result = validateSpecTargets(
      [
        "/tmp/spec.md",
        ".phronia/spec/../secret.md",
        "docs/requirements.md",
        ".phronia/spec",
        "",
      ],
      "/repo",
    );
    expect(result.ok).toBe(false);
    expect(result.invalid.map((item) => item.target)).toEqual([
      "/tmp/spec.md",
      ".phronia/spec/../secret.md",
      "docs/requirements.md",
      ".phronia/spec",
      "",
    ]);
    expect(result.invalid.map((item) => item.reason)).toEqual([
      "target must be repo-relative, not absolute",
      "target may not contain '..'",
      "target must start with .phronia/spec/",
      "target must start with .phronia/spec/",
      "target is empty",
    ]);
  });

  it("normalizes backslashes and ./ prefixes before validating", () => {
    expect(
      validateSpecTargets([".\\.phronia\\spec\\a.md"], "/repo").ok,
    ).toBe(true);
  });
});

describe("canSync", () => {
  it("requires a landed task and a delta", () => {
    const landed = {
      meta: { integration: { outcome: "landed" } },
      hasDelta: true,
    };
    expect(canSync(landed)).toBe(true);
    expect(canSync({ ...landed, hasDelta: false })).toBe(false);
    expect(
      canSync({
        meta: { integration: { outcome: "pushed" } },
        hasDelta: true,
      }),
    ).toBe(false);
    expect(canSync({ meta: {}, hasDelta: true })).toBe(false);
  });
});

describe("verifyChangedTargets", () => {
  it("reports targets that did not change and changed files not declared", () => {
    expect(
      verifyChangedTargets(
        [".phronia/spec/a.md", ".phronia/spec/b.md"],
        [".phronia/spec/a.md", ".phronia/spec/c.md"],
      ),
    ).toEqual({
      missing: [".phronia/spec/b.md"],
      extra: [".phronia/spec/c.md"],
    });
  });

  it("normalizes separators before comparing", () => {
    expect(
      verifyChangedTargets([".\\.phronia\\spec\\a.md"], [".phronia/spec/a.md"]),
    ).toEqual({ missing: [], extra: [] });
  });
});

describe("spec task facts", () => {
  it("treats meta.kind=spec as spec-only", () => {
    expect(isSpecOnly({ meta: { kind: "spec" } })).toBe(true);
    expect(isSpecOnly({ meta: { kind: "code" } })).toBe(false);
    expect(isSpecOnly({})).toBe(false);
  });

  it("reads meta.spec_sync.status with a safe default", () => {
    expect(readSpecSyncState({ spec_sync: { status: "synced" } })).toBe("synced");
    expect(readSpecSyncState({ spec_sync: { status: "bogus" } })).toBe("none");
    expect(readSpecSyncState({})).toBe("none");
  });

  it("projects a delta without a sync record as pending", () => {
    expect(
      resolveSpecDisplayState({ hasDelta: true, syncState: "none" }),
    ).toBe("pending");
    expect(
      resolveSpecDisplayState({ hasDelta: true, syncState: "synced" }),
    ).toBe("synced");
    expect(
      resolveSpecDisplayState({ hasDelta: false, syncState: "none" }),
    ).toBe("none");
    expect(
      resolveSpecDisplayState({ hasDelta: true, syncState: "failed" }),
    ).toBe("pending");
  });
});
