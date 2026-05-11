import { describe, expect, it, vi } from "vitest";
import {
  buildUpgradeCommand,
  npmBinary,
  resolveUpgradeTag,
  upgrade,
} from "../../src/commands/upgrade.js";

describe("upgrade command", () => {
  it("defaults stable versions to latest", () => {
    expect(resolveUpgradeTag("0.5.12")).toBe("latest");
  });

  it("defaults beta versions to beta", () => {
    expect(resolveUpgradeTag("0.6.0-beta.8")).toBe("beta");
  });

  it("defaults rc versions to rc", () => {
    expect(resolveUpgradeTag("0.5.0-rc.7")).toBe("rc");
  });

  it("honors an explicit tag or version", () => {
    expect(resolveUpgradeTag("0.6.0-beta.8", "latest")).toBe("latest");
    expect(resolveUpgradeTag("0.6.0-beta.8", "0.6.0-beta.9")).toBe(
      "0.6.0-beta.9",
    );
  });

  it("rejects shell-shaped tags", () => {
    expect(() => resolveUpgradeTag("0.5.12", "latest && rm -rf /")).toThrow(
      /Invalid npm tag\/version/,
    );
  });

  it("uses npm.cmd on Windows", () => {
    expect(npmBinary("win32")).toBe("npm.cmd");
    expect(npmBinary("darwin")).toBe("npm");
  });

  it("builds npm global install command", () => {
    expect(buildUpgradeCommand({ tag: "beta" }, "0.5.12")).toMatchObject({
      command: npmBinary(),
      args: ["install", "-g", "@mindfoldhq/trellis@beta"],
      target: "@mindfoldhq/trellis@beta",
      tag: "beta",
    });
  });

  it("dry-run does not execute npm", async () => {
    const runner = vi.fn();

    await upgrade({ dryRun: true, tag: "latest" }, runner);

    expect(runner).not.toHaveBeenCalled();
  });

  it("executes npm install for real upgrades", async () => {
    const runner = vi.fn(() => ({ status: 0, signal: null }));

    await upgrade({ tag: "latest" }, runner);

    expect(runner).toHaveBeenCalledWith(
      npmBinary(),
      ["install", "-g", "@mindfoldhq/trellis@latest"],
      { stdio: "inherit" },
    );
  });

  it("fails when npm exits non-zero", async () => {
    const runner = vi.fn(() => ({ status: 1, signal: null }));

    await expect(upgrade({ tag: "latest" }, runner)).rejects.toThrow(
      "npm install failed with exit code 1",
    );
  });
});
