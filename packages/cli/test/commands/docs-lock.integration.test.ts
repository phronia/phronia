import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDocsGenerate } from "../../src/commands/docs.js";

const roots: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "phronia-docs-lock-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("docs generate shared lock", () => {
  it("refuses to write while the integration lock is held", () => {
    const root = tempRepo();
    const lockFile = path.join(root, ".git", "phronia", "integration.lock");
    mkdirSync(path.dirname(lockFile), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      lockFile,
      JSON.stringify({
        schemaVersion: 1,
        owner: "other-task",
        phase: "merging",
        acquiredAt: now,
        heartbeatAt: now,
        ttlSeconds: 300,
      }),
    );

    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const code = runDocsGenerate({ cwd: root, json: true });
      expect(code).toBe(2);
      const payload = out.mock.calls
        .map((call) => String(call[0]))
        .join("");
      expect(payload).toContain("DOCS_LOCK_BUSY");
      expect(existsSync(path.join(root, "docs", "requirements.md"))).toBe(false);
    } finally {
      out.mockRestore();
    }
  });

  it("writes normally when the lock is free", () => {
    const root = tempRepo();
    mkdirSync(path.join(root, ".phronia", "tasks"), { recursive: true });
    const code = runDocsGenerate({ cwd: root, json: true });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, "docs", "requirements.md"))).toBe(true);
  });
});
