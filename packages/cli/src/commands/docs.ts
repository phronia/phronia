/**
 * `phronia docs generate` — regenerate the deterministic knowledge layer.
 * `architecture.md` and `product.md` are narrative and never generated.
 *
 * `docs/requirements.md` is a shared projection. The write takes the same
 * repository-level lease as `task integrate` so two tasks cannot rewrite it
 * concurrently (design §6.5/§12). `--check` takes the lease too: a check must
 * not read a half-written file.
 */

import { writeRequirements } from "@phronia/core";

import { createGitPort } from "../adapters/git.js";
import { createLeaseStore, isLeaseBusy, type LeaseRecord } from "../adapters/lease.js";
import { resolveSharedRuntime } from "../adapters/shared-runtime.js";

export interface DocsOptions {
  cwd: string;
  check?: boolean;
  json?: boolean;
}

export function runDocsGenerate(options: DocsOptions): number {
  let release: (() => void) | null = null;
  try {
    const git = createGitPort();
    const runtime = resolveSharedRuntime({ cwd: options.cwd, git });
    const store = createLeaseStore<LeaseRecord & {
      owner?: string;
      phase?: string;
    }>({
      path: runtime.paths.integrationLock,
      defaultTtlSeconds: 300,
    });
    const now = new Date().toISOString();
    const acquired = store.acquire({
      owner: "docs-generate",
      phase: "docs",
      acquiredAt: now,
      heartbeatAt: now,
      ttlSeconds: 300,
    });
    if (isLeaseBusy(acquired)) {
      const message =
        "another integration or docs generation is in progress; the shared projection is locked";
      const next = "retry after the current integrate/finish-work finishes";
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, code: "DOCS_LOCK_BUSY", message, next }, null, 2)}\n`,
        );
      } else {
        process.stderr.write(`DOCS_LOCK_BUSY: ${message}\nnext: ${next}\n`);
      }
      return 2;
    }
    release = () => store.release(acquired);
  } catch (error) {
    // A non-git checkout or an unwritable runtime must not make docs
    // generation impossible; warn and continue without cross-process locking.
    process.stderr.write(
      `warning: docs lock unavailable (${errorMessage(error)}); continuing without it\n`,
    );
  }

  try {
    const result = writeRequirements(options.cwd, { check: options.check });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ path: result.path, changed: result.changed }, null, 2)}\n`,
      );
    } else if (result.changed) {
      process.stdout.write(
        options.check
          ? `docs/requirements.md is stale; run \`phronia docs generate\`.\n`
          : `Wrote ${result.path}.\n`,
      );
    } else {
      process.stdout.write("docs/requirements.md is current.\n");
    }
    return options.check && result.changed ? 1 : 0;
  } finally {
    release?.();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
