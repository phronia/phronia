import { describe, expect, it } from "vitest";
import { installLegacyEnvAliases } from "../../src/cli/env-compat.js";

describe("legacy environment compatibility", () => {
  it("maps TRELLIS_* to PHRONIA_* without overwriting explicit values", () => {
    const env: NodeJS.ProcessEnv = {
      TRELLIS_HOOKS: "0",
      TRELLIS_CONTEXT_ID: "legacy",
      PHRONIA_CONTEXT_ID: "explicit",
    };

    const aliased = installLegacyEnvAliases(env);

    expect(aliased).toEqual(["TRELLIS_HOOKS"]);
    expect(env.PHRONIA_HOOKS).toBe("0");
    expect(env.PHRONIA_CONTEXT_ID).toBe("explicit");
    // The legacy value stays for child processes.
    expect(env.TRELLIS_CONTEXT_ID).toBe("legacy");
  });

  it("is a no-op when no legacy names exist", () => {
    const env: NodeJS.ProcessEnv = { PHRONIA_HOOKS: "1" };
    expect(installLegacyEnvAliases(env)).toEqual([]);
    expect(env.PHRONIA_HOOKS).toBe("1");
  });
});
