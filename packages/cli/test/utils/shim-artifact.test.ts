import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isShimArtifact } from "../../src/commands/update.js";

describe("shim artifact detection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes a stamped shim within the first 512 bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-shim-detect-"));
    roots.push(root);
    const file = path.join(root, "hook.py");
    fs.writeFileSync(
      file,
      "# phronia-shim: claude@v1\n# shim-version: 0.6.17\nprint('ok')\n",
    );
    expect(isShimArtifact(file)).toBe(true);
  });

  it("does not treat an ordinary template as a shim", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-shim-detect-"));
    roots.push(root);
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "# Notes\n");
    expect(isShimArtifact(file)).toBe(false);
  });

  it("returns false for a missing file", () => {
    expect(isShimArtifact("/definitely/missing/file.py")).toBe(false);
  });
});
