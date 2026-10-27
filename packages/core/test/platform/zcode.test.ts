import { describe, expect, it } from "vitest";
import {
  classifyZcodeVersion,
  selectZcodePath,
  zcodePathLabel,
} from "../../src/platform/zcode.js";

const handshake = {
  platform: "zcode",
  event: "session-start",
  adapterId: "zcode@v1",
  shimVersion: "0.6.17",
  observedPayloadKeys: ["session_id"],
  at: "2026-10-21T00:00:00Z",
};

describe("zcode build classification", () => {
  it("knows the disabled and restored generations", () => {
    expect(classifyZcodeVersion("3.7.9")).toBe("hooks-disabled");
    expect(classifyZcodeVersion("3.8.1")).toBe("hooks-restored");
    expect(classifyZcodeVersion("3.9.0")).toBe("unknown");
    expect(classifyZcodeVersion(null)).toBe("unknown");
  });
});

describe("zcode path selection", () => {
  it("falls back to prelude when hooks are disabled and no bridge exists", () => {
    const state = selectZcodePath({ version: "3.7.9" });
    expect(state.selected.kind).toBe("prelude");
    expect(state.reason).toBe("hooks-disabled-no-bridge");
  });

  it("uses the bridge when hooks are disabled but the bridge is installed", () => {
    const state = selectZcodePath({
      version: "3.7.9",
      bridgeInstalled: true,
      bridgePath: "~/.zcode/plugins/phronia-bridge.mjs",
    });
    expect(state.selected.kind).toBe("bridge");
    expect(zcodePathLabel(state.selected)).toContain("phronia-bridge");
  });

  it("assumes project hooks on a restored build", () => {
    const state = selectZcodePath({ version: "3.8.1" });
    expect(state.selected.kind).toBe("project-hooks");
    expect(state.trust).toBe("assumed");
  });

  it("confirms project hooks once a handshake exists", () => {
    const state = selectZcodePath({ version: "3.9.0", handshake });
    expect(state.selected.kind).toBe("project-hooks");
    expect(state.trust).toBe("confirmed");
    expect(state.reason).toBe("handshake observed");
  });

  it("prefers the project-local plugin when it is installed", () => {
    const state = selectZcodePath({
      version: "3.9.0",
      pluginInstalled: true,
      pluginDir: ".zcode/plugins/phronia",
    });
    expect(state.selected.kind).toBe("plugin");
    expect(state.trust).toBe("assumed");
    expect(zcodePathLabel(state.selected)).toContain(".zcode/plugins/phronia");
  });

  it("confirms the plugin path once a handshake exists", () => {
    const state = selectZcodePath({
      version: "3.9.0",
      handshake,
      pluginInstalled: true,
      pluginDir: ".zcode/plugins/phronia",
    });
    expect(state.selected.kind).toBe("plugin");
    expect(state.trust).toBe("confirmed");
    expect(state.reason).toBe("project plugin; handshake observed");
  });

  it("honors explicit pins above build evidence", () => {
    expect(
      selectZcodePath({ version: "3.8.1", pin: "prelude" }).selected.kind,
    ).toBe("prelude");
    expect(
      selectZcodePath({ version: "3.9.0", pin: "bridge" }).selected.kind,
    ).toBe("bridge");
    expect(
      selectZcodePath({ version: "3.7.9", pin: "project-hooks" }).selected.kind,
    ).toBe("project-hooks");
    expect(
      selectZcodePath({ version: "3.9.0", pin: "plugin" }).selected.kind,
    ).toBe("plugin");
  });
});
