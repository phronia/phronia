import { describe, expect, it } from "vitest";
import { PLATFORM_IDS } from "../../src/platform/ids.js";
import {
  CAPABILITIES,
  capabilitiesFor,
  validateCapabilities,
} from "../../src/platform/capabilities.js";
import { featureStatus } from "../../src/platform/features.js";

describe("capability matrix", () => {
  it("covers every platform exactly once", () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...PLATFORM_IDS].sort());
  });

  it("passes invariants", () => {
    expect(validateCapabilities()).toEqual([]);
  });

  it("declares all five behaviours for every platform", () => {
    for (const id of PLATFORM_IDS) {
      expect(Object.keys(CAPABILITIES[id].behavior).sort()).toEqual([
        "agentDefinitions",
        "sessionStart",
        "shellIdentity",
        "subagentContext",
        "workflowState",
      ]);
    }
  });

  it("requires a reason for every none mechanism", () => {
    for (const id of PLATFORM_IDS) {
      const behavior = CAPABILITIES[id].behavior;
      for (const mechanism of Object.values(behavior)) {
        if (mechanism.kind === "none") {
          expect(mechanism.reason.trim().length).toBeGreaterThanOrEqual(10);
        }
      }
    }
  });

  it("derives feature availability from the matrix", () => {
    expect(featureStatus("claude-code", "context.sessionStart").available).toBe(true);
    expect(featureStatus("kilo", "context.sessionStart")).toMatchObject({
      available: false,
    });
    expect(featureStatus("dsh", "rules.gate").available).toBe(true);
    expect(featureStatus("claude-code", "rules.gate").available).toBe(false);
    expect(featureStatus("claude-code", "task.branch").available).toBe(true);
  });

  it("keeps the three distinct loopControl values", () => {
    expect(CAPABILITIES.dsh.loopControl).toBe("full");
    expect(CAPABILITIES["claude-code"].loopControl).toBe("hooks");
    expect(CAPABILITIES.kilo.loopControl).toBe("none");
  });

  it("keeps the v1 profile when no adapter is named", () => {
    const profile = capabilitiesFor("opencode");
    expect(profile.behavior.sessionStart.event).toBe(
      "experimental.chat.messages.transform",
    );
    expect(profile.toolNames.subagent).toContain("task");
    expect(profile.toolNames.edit).toContain("apply_patch");
  });

  it("overrides the opencode v2 profile without touching other platforms", () => {
    const v2 = capabilitiesFor("opencode", "opencode@v2");
    expect(v2.behavior.sessionStart).toMatchObject({
      kind: "plugin",
      event: "session.hook context",
    });
    expect(v2.behavior.shellIdentity).toMatchObject({
      kind: "config",
      detail: "env OPENCODE_SESSION_ID",
    });
    expect(v2.toolNames).toEqual({
      shell: ["shell"],
      subagent: ["subagent"],
      edit: ["write", "edit", "patch"],
    });

    const codex = capabilitiesFor("codex");
    expect(codex.toolNames.shell).toContain("bash");
  });
});
