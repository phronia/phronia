import path from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUT, projectPath, workflowPath } from "../../src/layout/index.js";
import { envName, readEnv, readEnvFlag } from "../../src/layout/env.js";

describe("workspace layout", () => {
  it("exposes the workflow root and derived paths", () => {
    expect(LAYOUT.rootDirName).toBe(".trellis");
    expect(LAYOUT.brand).toBe("phronia");
    expect(LAYOUT.packageScope).toBe("@phronia");
    expect(LAYOUT.envPrefix).toBe("PHRONIA_");
    expect(LAYOUT.legacyRootDirName).toBe(".trellis");
    expect(LAYOUT.paths.tasks).toBe(".trellis/tasks");
    expect(LAYOUT.paths.sessions).toBe(".trellis/.runtime/sessions");
    expect(LAYOUT.paths.manifest).toBe(".trellis/.template-hashes.json");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(LAYOUT)).toBe(true);
    expect(Object.isFrozen(LAYOUT.paths)).toBe(true);
  });

  it("resolves paths against an explicit root", () => {
    const root = path.join(path.sep, "repo");
    expect(projectPath(root, "tasks")).toBe(path.join(root, ".trellis/tasks"));
    expect(workflowPath(root, "spec", "guides")).toBe(
      path.join(root, ".trellis/spec/guides"),
    );
  });
});

describe("environment compatibility", () => {
  it("prefers the Phronia prefix", () => {
    const result = readEnv("HOOKS", {
      env: { PHRONIA_HOOKS: "1", TRELLIS_HOOKS: "0" },
    });
    expect(result).toEqual({ value: "1", legacy: false, name: "PHRONIA_HOOKS" });
  });

  it("falls back to the legacy prefix and reports it", () => {
    const seen: string[] = [];
    const result = readEnv("DISABLE_HOOKS", {
      env: { TRELLIS_DISABLE_HOOKS: "1" },
      onLegacy: (legacy, next) => seen.push(`${legacy}->${next}`),
    });
    expect(result).toEqual({
      value: "1",
      legacy: true,
      name: "TRELLIS_DISABLE_HOOKS",
    });
    expect(seen).toEqual(["TRELLIS_DISABLE_HOOKS->PHRONIA_DISABLE_HOOKS"]);
  });

  it("reads boolean flags", () => {
    expect(readEnvFlag("HOOKS", { env: { PHRONIA_HOOKS: "off" } })).toBe(false);
    expect(readEnvFlag("HOOKS", { env: { PHRONIA_HOOKS: "yes" } })).toBe(true);
    expect(readEnvFlag("HOOKS", { env: { PHRONIA_HOOKS: "maybe" } })).toBeUndefined();
    expect(readEnvFlag("HOOKS", { env: {} })).toBeUndefined();
  });

  it("builds names from the layout prefix", () => {
    expect(envName("CONTEXT_ID")).toBe("PHRONIA_CONTEXT_ID");
  });
});
