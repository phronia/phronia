import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdapter } from "../../src/platform/selection.js";
import { updateHashes } from "../../src/utils/template-hash.js";

describe("installation adapter selection", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "phronia-adapter-select-"));
    mkdirSync(join(root, ".phronia"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("honors an explicit config pin over everything else", () => {
    writeFileSync(
      join(root, ".phronia", "config.yaml"),
      "platforms:\n  opencode:\n    adapter: opencode@v1\n",
      "utf8",
    );
    writeFileSync(
      join(root, ".phronia", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        phroniaVersion: "test",
        generatedAt: "",
        platforms: { opencode: { adapterId: "opencode@v2" } },
      }),
      "utf8",
    );

    const resolved = resolveAdapter(root, "opencode", { probe: false });
    expect(resolved.adapterId).toBe("opencode@v1");
    expect(resolved.source).toBe("pin");
  });

  it("keeps the recorded adapter when the probe is unavailable", () => {
    writeFileSync(
      join(root, ".phronia", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        phroniaVersion: "test",
        generatedAt: "",
        platforms: { opencode: { adapterId: "opencode@v2" } },
      }),
      "utf8",
    );

    const resolved = resolveAdapter(root, "opencode", { probe: false });
    expect(resolved.adapterId).toBe("opencode@v2");
    expect(resolved.source).toBe("recorded");
    expect(resolved.status).toBe("ok");
  });

  it("falls back to v1 on a fresh project without a probe", () => {
    const resolved = resolveAdapter(root, "opencode", { probe: false });
    expect(resolved.adapterId).toBe("opencode@v1");
    expect(resolved.source).toBe("fallback");
    expect(resolved.status).toBe("degraded");
  });

  it("infers the installed shard when no manifest is present", () => {
    const relative = ".opencode/plugins/phronia.js";
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(root, relative), "// v2 shim", "utf8");
    updateHashes(root, new Map([[relative, "// v2 shim"]]));

    const resolved = resolveAdapter(root, "opencode", { probe: false });
    expect(resolved.adapterId).toBe("opencode@v2");
    expect(resolved.source).toBe("installed");
  });

  it("treats a single-generation platform the same way", () => {
    const resolved = resolveAdapter(root, "codex", { probe: false });
    expect(resolved.adapterId).toBe("codex@v1");
  });
});
