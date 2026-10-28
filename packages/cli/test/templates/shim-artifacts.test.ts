import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const GENERATED = path.join(ROOT, "src/templates/_generated/shims");
const MANIFEST = path.join(GENERATED, "manifest.json");

describe("generated shim artifacts", () => {
  it("records every artifact with a matching content hash", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as {
      schemaVersion: number;
      buildId: string;
      artifacts: {
        path: string;
        adapterId: string;
        buildId: string;
        sha256: string;
        lines: number;
      }[];
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifacts).toHaveLength(4);
    expect(new Set(manifest.artifacts.map((item) => item.adapterId))).toEqual(
      new Set(["opencode@v1", "opencode@v2"]),
    );
    for (const artifact of manifest.artifacts) {
      const file = path.join(GENERATED, artifact.path);
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain(`// phronia-shim: ${artifact.adapterId}`);
      expect(text).toContain(`// build-id: ${manifest.buildId}`);
      expect(text).toContain(`// content-hash: ${artifact.sha256}`);
      const separator = text.indexOf("\n\n");
      expect(separator).toBeGreaterThan(0);
      const body = text.slice(separator + 2);
      expect(createHash("sha256").update(body).digest("hex")).toBe(artifact.sha256);
      expect(artifact.buildId).toBe(manifest.buildId);
      expect(artifact.lines).toBe(text.split("\n").length);
    }
  });

  it("does not keep a second copy of the assembly in the bundle", () => {
    for (const entry of ["session-start.js", "inject-workflow-state.js", "inject-subagent-context.js"]) {
      const text = fs.readFileSync(path.join(GENERATED, "v1", entry), "utf8");
      expect(text).not.toContain("readJsonlWithFiles");
      expect(text).not.toContain("materializeArtifact(");
      expect(text).toContain("runContext");
    }
    const v2 = fs.readFileSync(path.join(GENERATED, "v2", "phronia.js"), "utf8");
    expect(v2).not.toContain("readJsonlWithFiles");
    expect(v2).not.toContain("materializeArtifact(");
    expect(v2).toContain("runContext");
    expect(v2).toContain("phronia.opencode.v2");
  });
});
