import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const CLI_PKG = path.join(ROOT, "packages/cli/package.json");

describe("npm release metadata", () => {
  it("publishes only the phronia bin", () => {
    const pkg = JSON.parse(fs.readFileSync(CLI_PKG, "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(Object.keys(pkg.bin ?? {})).toEqual(["phronia"]);
  });

  it("keeps the staging script from reintroducing trellis/tl bins", () => {
    const staging = fs.readFileSync(
      path.join(ROOT, "packages/runtime/scripts/package-npm.mjs"),
      "utf8",
    );
    expect(staging).toContain('bin: { phronia: "./bin/phronia.js" }');
    expect(staging).not.toContain('trellis: "./bin/trellis.js"');
  });

  it("keeps a manual legacy entry point without advertising it as a bin", () => {
    expect(fs.existsSync(path.join(ROOT, "packages/cli/bin/trellis.js"))).toBe(true);
  });
});
