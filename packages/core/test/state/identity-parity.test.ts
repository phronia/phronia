import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDeveloper, readJournal } from "../../src/state/identity.js";
import { nodeFs } from "../../src/state/fs.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const SCRIPTS_DIR = path.join(
  REPO_ROOT,
  "packages/cli/src/templates/workflow/scripts",
);
const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

const PROBE = [
  "import json, os, sys",
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
  "from pathlib import Path",
  "from common.paths import get_developer, get_active_journal_file, count_lines",
  "root = Path(sys.argv[1])",
  "developer = get_developer(root)",
  "journal = get_active_journal_file(root)",
  "print(json.dumps({'developer': developer,",
  "                  'journal': (str(journal.relative_to(root)) if journal else None),",
  "                  'lines': (count_lines(journal) if journal else 0)}))",
].join("\n");

describe.skipIf(!pythonAvailable)("identity parity with Python", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-id-parity-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("matches local identity and journal selection", () => {
    fs.mkdirSync(path.join(root, ".phronia/workspace/alice"), { recursive: true });
    fs.writeFileSync(path.join(root, ".phronia/.developer"), "name=alice\n");
    fs.writeFileSync(path.join(root, ".phronia/workspace/alice/journal-1.md"), "a\n");
    fs.writeFileSync(
      path.join(root, ".phronia/workspace/alice/journal-3.md"),
      "x\ny\nz\n",
    );

    const result = spawnSync("python3", ["-c", PROBE, root], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const expected = JSON.parse(result.stdout) as {
      developer: string | null;
      journal: string | null;
      lines: number;
    };

    const developer = readDeveloper(root, nodeFs, { env: {} });
    const journal = readJournal(root, developer.name, nodeFs);
    expect(developer.name).toBe(expected.developer);
    expect(journal.file).toBe(expected.journal);
    expect(journal.lineCount).toBe(expected.lines);
  });

  it("matches missing identity", () => {
    const result = spawnSync("python3", ["-c", PROBE, root], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const expected = JSON.parse(result.stdout) as {
      developer: string | null;
      journal: string | null;
      lines: number;
    };
    const developer = readDeveloper(root, nodeFs, { env: {} });
    const journal = readJournal(root, developer.name, nodeFs);
    expect(developer.name).toBe(expected.developer);
    expect(journal.file).toBe(expected.journal);
    expect(journal.lineCount).toBe(expected.lines);
  });
});
