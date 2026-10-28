import { describe, expect, it } from "vitest";
import { PLATFORM_IDS } from "../../src/platform/ids.js";
import { featureStatus } from "../../src/platform/features.js";
import { CAPABILITIES } from "../../src/platform/capabilities.js";

describe("coordinator.mode feature gate (R22, COORD-03)", () => {
  it("is available only when execution is parallel/nested and workspace is per-task", () => {
    for (const id of PLATFORM_IDS) {
      const capabilities = CAPABILITIES[id];
      const status = featureStatus(id, "coordinator.mode");
      const expected =
        (capabilities.subagentExecution === "parallel" ||
          capabilities.subagentExecution === "nested") &&
        capabilities.subagentWorkspace === "per-task";
      expect(status.available, id).toBe(expected);
      if (!expected) {
        expect(status.reason, id).toBeTruthy();
      }
    }
  });

  it("does not treat unknown as supported", () => {
    for (const id of PLATFORM_IDS) {
      if (CAPABILITIES[id].subagentExecution !== "unknown") continue;
      const status = featureStatus(id, "coordinator.mode");
      expect(status.available, id).toBe(false);
      expect(status.reason, id).toContain("unknown");
    }
  });

  it("explains the fallback instead of failing silently", () => {
    expect(featureStatus("zcode", "coordinator.mode").reason).toContain(
      "use multi-session instead",
    );
    expect(featureStatus("kilo", "coordinator.mode").reason).toContain(
      "parallel or nested",
    );
  });
});
