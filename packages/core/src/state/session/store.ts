/**
 * Session runtime store (schema v2).
 *
 * A session pointer is a per-window file. v2 adds a worktree namespace, a
 * revision for compare-and-swap, and a last-seen timestamp for GC. Reads fall
 * back to the flat v1 path so an upgrade does not orphan existing sessions.
 */

import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "../../layout/index.js";

export const SESSION_SCHEMA_VERSION = 2 as const;
export const MAIN_WORKTREE_ID = "main";

export interface SessionV2 {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  platform?: string;
  contextKey: string;
  keySource?: string;
  worktreeId: string;
  worktreePath: string | null;
  repoRoot: string;
  sessionId?: string;
  conversationId?: string;
  transcriptPath?: string;
  currentTask: string | null;
  currentRun: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface UpdateSessionOptions {
  worktreePath?: string | null;
  repoRoot?: string;
  platform?: string;
  keySource?: string;
  now?: Date;
}

export interface UpdateResult {
  session: SessionV2 | null;
  written: boolean;
  conflicts: number;
}

export interface GcOptions {
  ttlDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface GcReport {
  removed: string[];
  kept: number;
  dryRun: boolean;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

export class SessionStore {
  constructor(private readonly root: string) {}

  sessionsDir(): string {
    return path.join(this.root, LAYOUT.paths.sessions);
  }

  filePath(worktreeId: string, key: string): string {
    return path.join(this.sessionsDir(), worktreeId, `${key}.json`);
  }

  legacyPath(key: string): string {
    return path.join(this.sessionsDir(), `${key}.json`);
  }

  read(worktreeId: string, key: string): SessionV2 | null {
    const nested = this.readFile(this.filePath(worktreeId, key), worktreeId, key);
    if (nested) return nested;
    return this.readFile(this.legacyPath(key), worktreeId, key);
  }

  list(worktreeId?: string): SessionV2[] {
    const out: SessionV2[] = [];
    for (const [id, file] of this.enumerateFiles()) {
      if (worktreeId && id !== worktreeId) continue;
      const key = path.basename(file, ".json");
      const session = this.readFile(file, id, key);
      if (session) out.push(session);
    }
    return out.length > 0 ? out : this.readFlat();
  }

  /**
   * Compare-and-swap update. The mutator sees the previous value (or a new
   * record); a revision mismatch retries the read, never merges stale state.
   */
  update(
    worktreeId: string,
    key: string,
    mutate: (previous: SessionV2 | null) => SessionV2,
    options: UpdateSessionOptions = {},
  ): UpdateResult {
    const now = options.now ?? new Date();
    const target = this.filePath(worktreeId, key);
    let conflicts = 0;
    return this.withLock(target, () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = this.read(worktreeId, key);
        const draft = mutate(previous);
        const next: SessionV2 = {
          ...draft,
          schemaVersion: SESSION_SCHEMA_VERSION,
          contextKey: draft.contextKey || key,
          worktreeId,
          worktreePath: options.worktreePath ?? draft.worktreePath ?? null,
          repoRoot: options.repoRoot ?? draft.repoRoot ?? this.root,
          platform: options.platform ?? draft.platform,
          keySource: options.keySource ?? draft.keySource,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? now.toISOString(),
          updatedAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
        };
        const onDisk = this.readRaw(target);
        if (onDisk && onDisk.revision !== (previous?.revision ?? -1)) {
          conflicts += 1;
          continue;
        }
        this.writeAtomic(target, next);
        // Once upgraded, remove the legacy flat copy so GC does not see two.
        if (previous && fs.existsSync(this.legacyPath(key))) {
          try {
            fs.unlinkSync(this.legacyPath(key));
          } catch {
            // another worktree may own it; leave it alone
          }
        }
        return { session: next, written: true, conflicts };
      }
      return { session: this.read(worktreeId, key), written: false, conflicts };
    });
  }

  touch(worktreeId: string, key: string, now = new Date()): boolean {
    return this.update(worktreeId, key, (previous) =>
      previous
        ? { ...previous, lastSeenAt: now.toISOString() }
        : newSession(key, worktreeId, this.root, now),
    ).written;
  }

  clearTask(worktreeId: string, key: string, expectedRevision?: number): boolean {
    return this.update(worktreeId, key, (previous) => {
      if (!previous) return newSession(key, worktreeId, this.root, new Date());
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) {
        return previous;
      }
      return { ...previous, currentTask: null, currentRun: null };
    }).written;
  }

  repointTask(taskRef: string, newRef: string, worktreeId?: string): number {
    let changed = 0;
    for (const session of this.list(worktreeId)) {
      if (session.currentTask !== taskRef) continue;
      const result = this.update(session.worktreeId, session.contextKey, (previous) =>
        previous
          ? { ...previous, currentTask: newRef }
          : { ...newSession(session.contextKey, session.worktreeId, this.root, new Date()), currentTask: newRef },
      );
      if (result.written) changed += 1;
    }
    return changed;
  }

  gc(options: GcOptions = {}): GcReport {
    const ttlDays = options.ttlDays ?? 30;
    const now = (options.now ?? new Date()).getTime();
    const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    let kept = 0;
    for (const [worktreeId, file] of this.enumerateFiles()) {
      const session = this.readFile(file, worktreeId, path.basename(file, ".json"));
      if (!session) continue;
      const lastSeen = Date.parse(session.lastSeenAt || session.updatedAt);
      const worktreeMissing =
        session.worktreePath !== null &&
        session.worktreePath !== "" &&
        !fs.existsSync(session.worktreePath);
      if (Number.isFinite(lastSeen) && lastSeen < cutoff && (worktreeMissing || !session.currentTask)) {
        if (!options.dryRun) {
          try {
            fs.unlinkSync(file);
          } catch {
            continue;
          }
        }
        removed.push(path.relative(this.root, file).split(path.sep).join("/"));
      } else {
        kept += 1;
      }
    }
    return { removed, kept, dryRun: options.dryRun === true };
  }

  private readFile(
    file: string,
    worktreeId: string,
    key: string,
  ): SessionV2 | null {
    const raw = this.readRaw(file) as Record<string, unknown> | null;
    if (!raw) return null;
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      platform: typeof raw.platform === "string" ? raw.platform : undefined,
      contextKey: typeof raw.contextKey === "string" ? raw.contextKey : key,
      keySource: typeof raw.keySource === "string" ? raw.keySource : undefined,
      worktreeId,
      worktreePath:
        typeof raw.worktreePath === "string" ? raw.worktreePath : null,
      repoRoot: typeof raw.repoRoot === "string" ? raw.repoRoot : this.root,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      conversationId:
        typeof raw.conversationId === "string" ? raw.conversationId : undefined,
      transcriptPath:
        typeof raw.transcriptPath === "string" ? raw.transcriptPath : undefined,
      currentTask:
        typeof raw.currentTask === "string"
          ? raw.currentTask
          : typeof raw.current_task === "string"
            ? raw.current_task
            : null,
      currentRun: raw.currentRun ?? null,
      revision: typeof raw.revision === "number" ? raw.revision : 0,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      lastSeenAt:
        typeof raw.lastSeenAt === "string"
          ? raw.lastSeenAt
          : typeof raw.last_seen_at === "string"
            ? raw.last_seen_at
            : "",
    };
  }

  private readRaw(file: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private enumerateFiles(): [string, string][] {
    const dir = this.sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const out: [string, string][] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push([MAIN_WORKTREE_ID, full]);
      } else if (entry.isDirectory()) {
        let children: string[] = [];
        try {
          children = fs.readdirSync(full);
        } catch {
          continue;
        }
        for (const child of children) {
          if (child.endsWith(".json")) {
            out.push([entry.name, path.join(full, child)]);
          }
        }
      }
    }
    return out;
  }

  private readFlat(): SessionV2[] {
    const dir = this.sessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        this.readFile(path.join(dir, entry), MAIN_WORKTREE_ID, entry.slice(0, -5)),
      )
      .filter((session): session is SessionV2 => session !== null);
  }

  private withLock<T>(target: string, run: () => T): T {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const lock = `${target}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lock, "wx");
      } catch {
        this.breakStaleLock(lock);
        if (Date.now() > deadline) {
          throw new Error(`session lock timeout: ${path.basename(lock)}`);
        }
        this.sleep(LOCK_RETRY_MS);
      }
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return run();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        fs.unlinkSync(lock);
      } catch {
        // lock was removed by a stale-lock breaker
      }
    }
  }

  private breakStaleLock(lock: string): void {
    try {
      const pid = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
      if (!Number.isFinite(pid) || pid <= 0) return;
      try {
        process.kill(pid, 0);
      } catch {
        fs.unlinkSync(lock);
      }
    } catch {
      // lock file disappeared or is unreadable; retry
    }
  }

  private sleep(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // Short synchronous backoff keeps the store usable from sync shims.
    }
  }

  private writeAtomic(target: string, session: SessionV2): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
  }
}

function newSession(
  key: string,
  worktreeId: string,
  root: string,
  now: Date,
): SessionV2 {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    contextKey: key,
    worktreeId,
    worktreePath: null,
    repoRoot: root,
    currentTask: null,
    currentRun: null,
    revision: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };
}
