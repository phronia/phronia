import fs from "node:fs";
import path from "node:path";

import { appendEvent } from "./store/events.js";
import {
  channelDir,
  currentProjectKey,
  ensureBucketMarker,
  eventsPath,
} from "./store/paths.js";

export interface CreateOptions {
  task?: string;
  project?: string;
  labels?: string;
  cwd?: string;
  by?: string;
  force?: boolean;
  /** Mark this channel as ephemeral — `channel list` hides it by default
   *  and `channel prune --ephemeral` will remove it. The channel
   *  otherwise behaves identically (events.jsonl, workers, replay are
   *  all the same); the flag is purely a lifecycle hint. */
  ephemeral?: boolean;
  /** What created this channel (e.g. `"run"` for `channel run`-spawned
   *  ones, undefined for manual `channel create`). Lets consumers
   *  distinguish "auto-cleanup-able one-shot" from "user marked
   *  ephemeral on purpose". */
  origin?: string;
}

export async function createChannel(
  name: string,
  opts: CreateOptions,
): Promise<void> {
  const events = eventsPath(name);
  const dir = channelDir(name);

  if (fs.existsSync(events) && !opts.force) {
    throw new Error(
      `Channel '${name}' already exists at ${dir}. Use --force to overwrite.`,
    );
  }

  if (opts.force && fs.existsSync(dir)) {
    await forceCleanChannel(name);
  }

  // Stamp the project bucket so future migrations and `listProjects`
  // recognise it (project key derives from the cwd at create time).
  ensureBucketMarker(currentProjectKey());

  const cwd = opts.cwd ?? process.cwd();
  const labels = opts.labels
    ? opts.labels
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    : undefined;

  await appendEvent(name, {
    kind: "create",
    by: opts.by ?? "main",
    cwd,
    ...(opts.task ? { task: opts.task } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    ...(labels ? { labels } : {}),
    ...(opts.ephemeral ? { ephemeral: true } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  });

  console.log(`Created channel '${name}' at ${dir}`);
  if (opts.ephemeral) {
    process.stderr.write(
      "ephemeral channel is hidden from `channel list`; use `channel list --all` or `channel prune --ephemeral`\n",
    );
  }
}

/**
 * Full cleanup for `--force`: kill any live worker processes and remove
 * every per-worker file (pid / config / log / session-id / thread-id /
 * spawnlock), the channel lock, and events.jsonl. Leaves a clean directory
 * for the new create.
 *
 * SECURITY: only operates within `~/.trellis/channels/<name>/`. Resolves
 * `name` to an absolute path and refuses to descend outside that root.
 */
async function forceCleanChannel(name: string): Promise<void> {
  const dir = channelDir(name);
  // Kill any live workers first (signal supervisor by pid; on failure,
  // still proceed — the worst case is an orphan process which won't see
  // the new channel anyway because pid files will be gone).
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // nothing to clean
  }
  for (const f of entries) {
    if (!f.endsWith(".pid")) continue;
    const pidFile = path.join(dir, f);
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    } catch {
      continue;
    }
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        // Best-effort grace: poll up to 1.5s for it to exit.
        const deadline = Date.now() + 1500;
        while (pidAlive(pid) && Date.now() < deadline) {
          await sleep(50);
        }
        if (pidAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }

  // Now remove the whole channel directory. The channel-level lock file,
  // worker pid/config/log/session-id/thread-id/spawnlock are all under
  // this root. `rmSync(recursive)` handles them in one go.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[channel create --force] warning: failed to fully clean ${dir}: ${err instanceof Error ? err.message : err}\n`,
    );
  }
  // appendEvent will recreate the directory via ensureChannelDir.
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
