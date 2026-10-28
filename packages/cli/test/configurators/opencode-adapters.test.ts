import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectOpenCodeTemplates,
  OPENCODE_V1,
  OPENCODE_V2,
} from "../../src/configurators/opencode.js";
import { reconcileOpenCodeAdapter } from "../../src/configurators/adapter-files.js";
import { loadHashes, updateHashes } from "../../src/utils/template-hash.js";

function write(cwd: string, relative: string, content: string): void {
  const absolute = join(cwd, ...relative.split("/"));
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

describe("opencode adapter template composition", () => {
  it("keeps agents and commands in both generations", () => {
    for (const adapterId of [OPENCODE_V1, OPENCODE_V2]) {
      const files = collectOpenCodeTemplates(adapterId);
      expect(files.has(".opencode/agents/phronia-implement.md")).toBe(true);
      expect(
        [...files.keys()].some(
          (key) =>
            key.startsWith(".opencode/commands/phronia/") && key.endsWith(".md"),
        ),
      ).toBe(true);
      expect(
        [...files.keys()].some((key) =>
          key.startsWith(".opencode/skills/phronia-check/"),
        ),
      ).toBe(true);
    }
  });

  it("selects the v1 plugins and package manifest", () => {
    const files = collectOpenCodeTemplates(OPENCODE_V1);
    expect(files.has(".opencode/plugins/session-start.js")).toBe(true);
    expect(files.has(".opencode/plugins/inject-workflow-state.js")).toBe(true);
    expect(files.has(".opencode/plugins/inject-subagent-context.js")).toBe(true);
    expect(files.has(".opencode/package.json")).toBe(true);
    expect(files.get(".opencode/plugins/session-start.js")).toContain(
      "phronia-shim: opencode@v1",
    );
  });

  it("selects one zero-dependency v2 plugin and no package manifest", () => {
    const files = collectOpenCodeTemplates(OPENCODE_V2);
    expect(files.has(".opencode/plugins/phronia.js")).toBe(true);
    expect(files.has(".opencode/plugins/session-start.js")).toBe(false);
    expect(files.has(".opencode/package.json")).toBe(false);
    const plugin = files.get(".opencode/plugins/phronia.js") ?? "";
    expect(plugin).toContain("phronia-shim: opencode@v2");
    expect(plugin).not.toContain("@opencode/plugin");
  });
});

describe("opencode adapter reconciliation", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phronia-adapter-reconcile-"));
    mkdirSync(join(root, ".phronia"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function installV1(): void {
    const files = new Map([
      [".opencode/plugins/session-start.js", "v1-session"],
      [".opencode/plugins/inject-workflow-state.js", "v1-workflow"],
      [".opencode/plugins/inject-subagent-context.js", "v1-subagent"],
      [".opencode/lib/debug.js", "v1-debug"],
      [".opencode/package.json", "{}"],
    ]);
    for (const [relative, content] of files) write(root, relative, content);
    updateHashes(root, files);
  }

  it("removes unmodified v1 files, keeps package.json, and clears hashes", () => {
    installV1();
    const result = reconcileOpenCodeAdapter(
      root,
      OPENCODE_V2,
      new Set([".opencode/plugins/phronia.js"]),
    );

    expect(result.removed).toContain(".opencode/plugins/session-start.js");
    expect(result.removed).toContain(".opencode/lib/debug.js");
    expect(fs.existsSync(join(root, ".opencode/plugins/session-start.js"))).toBe(
      false,
    );
    expect(fs.existsSync(join(root, ".opencode/package.json"))).toBe(true);
    const hashes = loadHashes(root);
    expect(hashes[".opencode/plugins/session-start.js"]).toBeUndefined();
    // The file stays, but v2 stops managing it so later updates do not treat
    // it as a deleted template.
    expect(hashes[".opencode/package.json"]).toBeUndefined();
  });

  it("keeps a user-modified shard file and its hash", () => {
    installV1();
    write(root, ".opencode/plugins/session-start.js", "user edit");
    const result = reconcileOpenCodeAdapter(
      root,
      OPENCODE_V2,
      new Set([".opencode/plugins/phronia.js"]),
    );

    expect(result.kept).toContain(".opencode/plugins/session-start.js");
    expect(fs.existsSync(join(root, ".opencode/plugins/session-start.js"))).toBe(
      true,
    );
    expect(loadHashes(root)[".opencode/plugins/session-start.js"]).toBeDefined();
  });

  it("is idempotent: a second switch removes nothing else", () => {
    installV1();
    const desired = new Set([".opencode/plugins/phronia.js"]);
    const first = reconcileOpenCodeAdapter(root, OPENCODE_V2, desired);
    const second = reconcileOpenCodeAdapter(root, OPENCODE_V2, desired);
    expect(first.removed.length).toBeGreaterThan(0);
    expect(second.removed).toEqual([]);
  });
});
