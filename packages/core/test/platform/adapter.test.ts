import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  adapterById,
  adaptersFor,
  selectAdapter,
} from "../../src/platform/registry.js";
import { parseSemver, satisfiesRange } from "../../src/platform/semver.js";
import { probeHarnessVersion } from "../../src/platform/probe.js";
import {
  handshakeAgeMs,
  manifestPath,
  readAdapterManifest,
  readHandshake,
  recordPlatform,
  writeAdapterManifest,
  writeHandshake,
} from "../../src/platform/manifest.js";

describe("semver ranges", () => {
  it("parses the first version in harness output", () => {
    expect(parseSemver("opencode 1.14.39")).toEqual({ major: 1, minor: 14, patch: 39 });
    expect(parseSemver("no version here")).toBeNull();
  });

  it("matches comparator and caret ranges", () => {
    expect(satisfiesRange("1.14.39", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesRange("1.9.9", "^1.2.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
  });
});

describe("harness probing", () => {
  it("reports a detected version with high confidence", () => {
    const result = probeHarnessVersion("opencode", () => "opencode 1.14.39\n");
    expect(result).toMatchObject({
      status: "detected",
      harnessVersion: "1.14.39",
      source: "cli",
      confidence: "high",
    });
  });

  it("degrades to unknown when the command is missing", () => {
    const result = probeHarnessVersion("opencode", () => null);
    expect(result).toMatchObject({ status: "unknown", harnessVersion: null });
  });

  it("uses ZCODE_APP_VERSION when no zcode CLI is on PATH", () => {
    const result = probeHarnessVersion("zcode", () => null, {
      ZCODE_APP_VERSION: "3.16.3",
    });
    expect(result).toMatchObject({
      status: "detected",
      harnessVersion: "3.16.3",
      source: "runtime",
      confidence: "high",
      reason: "ZCODE_APP_VERSION",
    });
  });

  it("falls back to the zcode CLI when ZCODE_APP_VERSION is absent", () => {
    const result = probeHarnessVersion("zcode", () => "3.7.2\n", {});
    expect(result).toMatchObject({
      status: "detected",
      harnessVersion: "3.7.2",
      source: "cli",
    });
  });

  it("degrades to unknown on unparsable output", () => {
    const result = probeHarnessVersion("opencode", () => "build abcdef");
    expect(result).toMatchObject({
      status: "unknown",
      harnessVersion: null,
      source: "cli",
    });
  });

  it("returns unknown for platforms without a stable command", () => {
    const result = probeHarnessVersion("kilo", () => "1.0.0");
    expect(result).toMatchObject({ status: "unknown", source: "none" });
  });
});

describe("adapter selection", () => {
  it("selects opencode v1 for a 1.x harness", () => {
    const selection = selectAdapter({
      platform: "opencode",
      detection: {
        status: "detected",
        harnessVersion: "1.14.39",
        source: "cli",
        confidence: "high",
      },
    });
    expect(selection.adapter?.id).toBe("opencode@v1");
    expect(selection.status).toBe("ok");
  });

  it("refuses opencode v1 for a 2.x harness and reports v2 unimplemented", () => {
    const selection = selectAdapter({
      platform: "opencode",
      detection: {
        status: "detected",
        harnessVersion: "2.1.0",
        source: "cli",
        confidence: "high",
      },
    });
    expect(selection.adapter?.id).toBe("opencode@v2");
    expect(selection.status).toBe("unsupported");
  });

  it("degrades to v1 when the version is unknown", () => {
    const selection = selectAdapter({
      platform: "opencode",
      detection: {
        status: "unknown",
        harnessVersion: null,
        source: "none",
        confidence: "low",
        reason: "version-unknown",
      },
    });
    expect(selection.adapter?.id).toBe("opencode@v1");
    expect(selection.status).toBe("degraded");
    expect(selection.fallback).toBe("skills");
  });

  it("honors an explicit pin", () => {
    const selection = selectAdapter({
      platform: "opencode",
      pin: "opencode@v1",
      detection: {
        status: "detected",
        harnessVersion: "2.0.0",
        source: "cli",
        confidence: "high",
      },
    });
    expect(selection.adapter?.id).toBe("opencode@v1");
    expect(selection.reason).toBe("config-pin");
  });

  it("rejects a pin for another platform", () => {
    const selection = selectAdapter({
      platform: "codex",
      pin: "opencode@v1",
      detection: {
        status: "unknown",
        harnessVersion: null,
        source: "none",
        confidence: "low",
      },
    });
    expect(selection.adapter).toBeNull();
    expect(selection.status).toBe("unsupported");
  });

  it("registers one adapter per platform generation", () => {
    expect(adapterById("opencode@v1")).not.toBeNull();
    expect(adapterById("opencode@v2")).not.toBeNull();
    expect(adaptersFor("codex").map((entry) => entry.id)).toEqual(["codex@v1"]);
    expect(ADAPTERS.some((entry) => entry.id === "dsh@v1")).toBe(true);
  });
});

describe("adapter manifest and handshake", () => {
  it("round-trips a manifest and survives a corrupt file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-manifest-"));
    try {
      expect(readAdapterManifest(root).schemaVersion).toBe(1);
      let manifest = readAdapterManifest(root);
      manifest = recordPlatform(manifest, "opencode", {
        adapterId: "opencode@v1",
        harnessVersion: "1.14.39",
        harnessVersionSource: "cli",
        confidence: "high",
        shimVersion: "0.6.17",
        status: "ok",
        detectedAt: "2026-10-21T00:00:00Z",
      });
      expect(writeAdapterManifest(root, manifest)).toBe(true);
      expect(readAdapterManifest(root).platforms.opencode?.adapterId).toBe(
        "opencode@v1",
      );
      // An unchanged write is skipped.
      expect(writeAdapterManifest(root, readAdapterManifest(root))).toBe(false);

      fs.writeFileSync(manifestPath(root), "{broken", "utf8");
      expect(readAdapterManifest(root).platforms).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records handshake keys but never values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-handshake-"));
    try {
      writeHandshake(root, "claude", "session-start", "claude@v1", {
        session_id: "secret-session",
        cwd: "/secret/path",
      });
      const record = readHandshake(root, "claude");
      expect(record?.observedPayloadKeys).toEqual(["cwd", "session_id"]);
      expect(JSON.stringify(record)).not.toContain("secret-session");
      expect(handshakeAgeMs(record)).toBeGreaterThanOrEqual(0);

      const before = fs.readFileSync(
        path.join(root, ".phronia/.runtime/harness/claude.json"),
        "utf8",
      );
      writeHandshake(root, "claude", "session-start", "claude@v1", {
        cwd: "/secret/path",
        session_id: "other",
      });
      const after = fs.readFileSync(
        path.join(root, ".phronia/.runtime/harness/claude.json"),
        "utf8",
      );
      // A different value with the same keys must not rewrite the file.
      expect(after).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
