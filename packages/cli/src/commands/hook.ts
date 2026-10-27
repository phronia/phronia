/**
 * `phronia hook` — the stable harness entrypoint.
 *
 * Harness configs call this command instead of embedding project paths. It
 * resolves the nearest `.phronia/` root (ZCode's `ZCODE_PROJECT_DIR` is the tool
 * cwd, not the workspace root) and delegates to the platform shim.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot } from "@phronia/core/layout";

export interface HookCommandOptions {
  platform: string;
  event: string;
}

export function runHookCommand(options: HookCommandOptions): number {
  if (options.platform !== "zcode") {
    process.stderr.write(
      `phronia hook: unsupported platform ${options.platform}\n`,
    );
    return 2;
  }

  const zcodeDir = process.env.ZCODE_PROJECT_DIR?.trim();
  const claudeDir = process.env.CLAUDE_PROJECT_DIR?.trim();
  const fromEnv = zcodeDir && zcodeDir.length > 0 ? zcodeDir : claudeDir;
  const start = fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd();
  const root = findProjectRoot(start) ?? findProjectRoot(process.cwd());
  if (!root) {
    process.stderr.write(`phronia hook: no .phronia project found from ${start}\n`);
    return 1;
  }

  const shim = path.join(root, ".zcode", "hooks", "phronia-hook.py");
  if (!fs.existsSync(shim)) {
    process.stderr.write(
      `phronia hook: ${path.relative(root, shim)} is missing; run \`phronia update\`\n`,
    );
    return 1;
  }

  const python = process.platform === "win32" ? "python" : "python3";
  const entry = process.argv[1];
  const result = spawnSync(
    python,
    [shim, "--event", options.event, "--platform", "zcode"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ZCODE_PROJECT_DIR: root,
        ...(entry ? { PHRONIA_CLI_PATH: entry } : {}),
      },
    },
  );
  if (result.error) {
    process.stderr.write(`phronia hook: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
