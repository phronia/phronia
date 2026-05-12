# `trellis channel` — Multi-Agent Collaboration Runtime (Code Spec)

Executable contracts for `packages/cli/src/commands/channel/`. Read this
before editing any file under that path. Trigger qualifies for mandatory
code-spec depth (new command surface + cross-layer event contract + infra
integration via env wiring and storage layout).

---

## 1. Scope / Trigger

| Trigger | Why this requires code-spec depth |
|---------|------------------------------------|
| New top-level `channel` command tree (11 subcommands) | New CLI surface — signatures must be locked |
| Event-stream protocol (events.jsonl, fixed kind taxonomy) | Cross-component contract: workers, supervisor, CLI all parse the same payloads |
| Per-worker subprocess supervision (claude / codex) | Infra integration: process lifecycle + signal handling |
| Disk layout migration (legacy flat → project buckets) | Infra: irreversible filesystem move + cross-tool path conventions (claude code parity) |
| Worker provider plugin (`WorkerAdapter`) | Extension contract: future providers depend on shape stability |
| Env wiring (`TRELLIS_CHANNEL_ROOT/PROJECT/AS`) | Cross-process configuration |

---

## 2. Signatures

### CLI commands (`commands/channel/index.ts`)

```
trellis channel create <name> [opts]
  --task <path>          : associated Trellis task directory (string)
  --project <slug>       : project metadata tag (string; NOT the bucket key)
  --labels <csv>         : comma-separated labels
  --cwd <path>           : cwd recorded in create event (default process.cwd())
  --by <agent>           : creator identity (default "main")
  --force                : if channel exists, kill workers + rmrf + recreate
  --ephemeral            : mark for hide-from-list + prune --ephemeral
  → stdout: "Created channel '<name>' at <abs-path>"
  → stderr (if --ephemeral): hint about list --all / prune --ephemeral
  → exit 0 success; throw if --force=false and channel exists

trellis channel spawn <name> [opts]
  --agent <name>         : load .trellis/agents/<name>.md (sets provider / as / system prompt)
  --provider <p>         : claude | codex (overrides agent)
  --as <worker-name>     : worker identifier (default = agent name)
  --cwd <path>           : worker cwd (default process.cwd())
  --model <id>           : model override
  --resume <id>          : resume an existing session/thread id
  --timeout <duration>   : auto-kill after duration (e.g. "30m", "1h", "7200s")
  --file <path>          : context file (repeatable, glob OK)
  --jsonl <path>         : manifest of {file, reason} entries (repeatable)
  --by <agent>           : caller identity recorded on `spawned` event
  → stdout (one line, JSON): {"pid": number, "log": string, "worker": string}
  → throws if worker name in use, agent not found, provider missing, channel not found

trellis channel send <name> [text] [opts]
  --as <agent>           : sender identity (REQUIRED)
  --kind <tag>           : user tag (e.g. interrupt / final_answer / question)
  --to <agents>          : CSV of target worker names (default: broadcast)
  --stdin                : read body from stdin
  --text-file <path>     : read body from file
  [text] positional      : inline body
  → stdout: appended event as JSON
  → throws if none of stdin/textFile/[text] provided

trellis channel wait <name> [opts]
  --as <agent>           : caller identity (REQUIRED, also default --to)
  --timeout <duration>   : max wait (no timeout = wait indefinitely)
  --from <agents>        : CSV — only wake on events from these authors
  --kind <kind>          : only wake on this event kind
  --tag <tag>            : only wake on this user tag
  --to <target>          : only wake on events to this target (default = --as)
  --include-progress     : also wake on progress events
  --all                  : require EVERY agent in --from to emit a match (default: first-match wins)
  → stdout: matching event(s) as JSON (one line each)
  → exit 0 satisfied; exit 124 timeout
  → on --all timeout: stderr "timeout: still waiting on <csv>"

trellis channel messages <name> [opts]
  --raw                  : one JSON event per line
  --follow               : tail new events after history (Ctrl-C to stop)
  --last <N>             : show only the last N matching
  --since <seq>          : only events with seq > N
  --kind <kind>          : filter by kind
  --from <agents>        : filter by author (CSV)
  --to <target>          : filter by routing target
  --tag <tag>            : filter by user tag
  --no-progress          : hide progress events
  → stdout: formatted (default) or raw JSON event stream

trellis channel list [opts]
  --json                 : emit JSON array instead of table
  --project <slug>       : filter by `task` field substring
  --all                  : include ephemeral channels (marked with " *")
  --all-projects         : scan every project bucket (default: only cwd's project)
  → stdout: table or JSON
  → footer (if hidden ephemerals): "(N ephemeral channels hidden — use --all to show)"

trellis channel kill <name> [opts]
  --as <agent>           : worker name (REQUIRED)
  --force                : SIGKILL immediately (skip graceful)
  → exit 0 sent; non-zero if no such worker

trellis channel rm <name>
  → kill any live workers, rmrf channel dir
  → exit 0 removed; throws if not found

trellis channel prune [opts]
  --all                  : remove all channels (except live + --keep)
  --empty                : remove channels with only the create event
  --idle <duration>      : remove channels whose last event is older than duration
  --ephemeral            : remove only ephemeral channels
  --keep <csv>           : whitelist channel names
  --yes                  : actually delete (default is dry-run)
  --dry-run              : show what would be removed (default behavior)
  → throws if --all/--empty/--idle/--ephemeral specified more than one
  → stdout: list of candidates + "(dry-run) would remove N" or "Removed N"

trellis channel run [name] [opts]
  (auto-generates name "run-<8hex>" if not provided, --ephemeral implied)
  --agent / --provider / --as / --cwd / --model / --file / --jsonl  : same as spawn
  --message <text>       : inline prompt
  --message-file <path>  : read prompt from file
  --stdin                : read prompt from stdin
  --tag <tag>            : user tag for the prompt
  --timeout <duration>   : max wait for done (default 5m)
  → on success: stdout = worker's final message body, channel auto-rm'd, exit 0
  → on failure (error/killed/timeout): channel preserved, stderr "channel kept for inspection: <path>", exit 1
```

### Internal modules

```ts
// store/paths.ts (storage-layer signatures)
channelRoot(): string                                       // TRELLIS_CHANNEL_ROOT ?? ~/.trellis/channels
projectKey(cwd: string): string                             // sanitize: /[\\/_]/g→"-" then /[^A-Za-z0-9.-]/g→"-"
currentProjectKey(): string                                 // TRELLIS_CHANNEL_PROJECT env ?? projectKey(process.cwd())
projectDir(project?: string): string                        // <root>/<project>
channelDir(name, project?: string): string                  // <root>/<project>/<name>
eventsPath(name, project?): string                          // <channelDir>/events.jsonl
lockPath(name, project?): string                            // <channelDir>/<name>.lock
workerFile(name, worker, suffix, project?): string          // <channelDir>/<worker>.<suffix>
workerLockPath(name, worker, project?): string              // <channelDir>/<worker>.spawnlock
migrateLegacyChannels(): void                               // idempotent; moves flat → _legacy/
ensureBucketMarker(project: string): void                   // touch <project>/.bucket
listProjects(): string[]                                    // bucket names (has .bucket OR is reserved)
selectExistingChannelProject(name: string): string          // throws if not found / ambiguous

// store/events.ts
appendEvent(name, partial: Omit<ChannelEvent,'seq'|'ts'>): Promise<ChannelEvent>
  // Atomic under withLock(lockPath(name)). Reads last seq, writes seq=last+1.
  // Returns event with ts (ISO) and seq (monotonic).

watchEvents(name, filter: WatchFilter, opts?: {signal?, fromStart?, sinceSeq?}): AsyncGenerator<ChannelEvent>
  // Default: from EOF (live tail). fromStart: from byte 0. sinceSeq: skip seq <= N.
  // Driven by fs.watch + 200ms poll fallback.

// adapters/index.ts
interface WorkerAdapter {
  readonly provider: Provider;                              // "claude" | "codex"
  buildArgs(view: SupervisorView): string[];                // CLI args for spawn()
  createCtx(): AdapterCtx;                                  // per-worker state
  handshake?(args: {child, ctx, view}): Promise<void>;      // optional pre-traffic init
  isReady(ctx: AdapterCtx): boolean;                        // safe to forward inbox now?
  parseLine(line: string, ctx: AdapterCtx): ParseResult;    // stdout line → events + side effects
  encodeUserMessage(text: string, tag: string|undefined, ctx: AdapterCtx): string;
}

// supervisor/shutdown.ts
interface ShutdownController {
  request(signal: NodeJS.Signals, reason: "explicit-kill"|"timeout"|"crash"): Promise<void>;
  claim(reason): boolean;                                   // sync intent latch (no ladder)
  isShuttingDown(): boolean;
  reason(): ShutdownReason | null;
  markTerminalEmitted(): void;                              // call BEFORE await appendEvent({kind:"done"|"error"})
  hasTerminalEvent(): boolean;
  finalizeOnExit(code: number|null, signal: NodeJS.Signals|null): Promise<void>;
  awaitFinalize(): Promise<void>;
}
```

---

## 3. Contracts

### Event payload contracts (events.jsonl)

All events carry: `seq: number` (monotonic ≥ 1), `ts: string` (ISO 8601),
`by: string` (author identity), `kind: ChannelEventKind`. Any extra fields
are kind-specific.

```ts
type ChannelEventKind = "create" | "join" | "leave" | "message" | "spawned"
  | "killed" | "respawned" | "progress" | "done" | "error" | "waiting" | "awake";
```

| Kind | Required (beyond base) | Optional | Producer |
|------|------------------------|----------|----------|
| `create` | `cwd: string` | `task: string`, `project: string`, `labels: string[]`, `ephemeral: true`, `origin: "run"` | CLI |
| `spawned` | `as: string`, `provider: "claude"\|"codex"`, `pid: number` | `agent: string`, `files: string[]`, `manifests: string[]` | supervisor |
| `message` | `text: string` | `to: string \| string[]`, `tag: string` | any |
| `progress` | `detail: object` (free-form) | — | adapter |
| `done` | — | `duration_ms: number`, `total_cost_usd: number`, `num_turns: number`, `synthesized: true`, `exit_code: number` | adapter (real) / supervisor (synthesised) |
| `error` | `message: string` | `detail: object`, `provider: string`, `synthesized: true`, `exit_code`, `exit_signal` | supervisor / adapter |
| `killed` | `reason: "explicit-kill"\|"timeout"\|"crash"`, `signal: NodeJS.Signals` | `timeout_ms: number` (if reason="timeout") | supervisor |
| `respawned` | (reserved, no fields yet) | — | (future) |

**Author identity (`by`) shape**: `"main"`, `"<worker-name>"`, `"supervisor:<worker>"`, or `"cli:<command>"` (e.g. `cli:kill`).

**Routing (`to`) semantics**: omitted = broadcast. Workers ONLY consume events with `to` matching their own name (broadcasts are operator/user-facing). CLI filters (`--to <target>`) follow `watchEvents` rules: events with no `to` pass through (broadcast); explicit `to` mismatch rejects.

**Terminal event invariant**: every spawned worker MUST eventually produce exactly one of `done` or supervisor-synthesised fallback. `ShutdownController.markTerminalEmitted()` claims the slot **synchronously before** `await appendEvent({kind: done|error})` to prevent races with `finalizeOnExit`.

### Storage layout contract

```
<root>/                              # TRELLIS_CHANNEL_ROOT ?? ~/.trellis/channels
├── _legacy/                         # reserved bucket (auto-migrated flat channels)
│   └── .bucket
├── _default/                        # reserved bucket name (currently unused)
└── <projectKey(cwd)>/               # one bucket per project
    ├── .bucket                      # marker — distinguishes bucket from legacy channel
    └── <channel-name>/
        ├── events.jsonl             # single source of truth, append-only
        ├── <name>.lock              # O_EXCL append-mutex (pid-stamped)
        ├── <worker>.pid             # supervisor pid
        ├── <worker>.worker-pid      # worker child pid
        ├── <worker>.config          # serialized SupervisorConfig JSON
        ├── <worker>.log             # raw worker stdout+stderr
        ├── <worker>.session-id      # claude resume key (persists across cleanup)
        ├── <worker>.thread-id       # codex resume key (persists across cleanup)
        ├── <worker>.inbox-cursor    # last seq forwarded to worker stdin (persists)
        └── <worker>.spawnlock       # spawn-time mutex
```

**Bucket discovery rules**:
- Top-level dir is a bucket iff it has `.bucket` file OR name is `_legacy` / `_default`
- Any other top-level dir with `events.jsonl` inside is a legacy channel → auto-migrated
- Reserved bucket names: `_legacy`, `_default` (never written as projectKey output because projectKey never starts with `_`)

**Cleanup contract** (`cleanup(channel, worker)` in supervisor.ts):
- ALWAYS removes: `pid`, `worker-pid`, `config`, `spawnlock`
- NEVER removes: `log`, `session-id`, `thread-id`, `inbox-cursor`, `events.jsonl`

### Env wiring

| Variable | Required? | Default | Used by |
|----------|-----------|---------|---------|
| `TRELLIS_CHANNEL_ROOT` | optional | `~/.trellis/channels` | `channelRoot()` — override storage root |
| `TRELLIS_CHANNEL_PROJECT` | optional | `projectKey(process.cwd())` | `currentProjectKey()` — lock current project bucket |
| `TRELLIS_CHANNEL_AS` | optional | `"main"` | `spawn.ts` — default for `spawnedBy` on `spawned` event (lets workers spawning workers record correct lineage) |
| `TRELLIS_HOOKS` | set to `"0"` by supervisor | n/a | supervised workers — disables trellis hooks inside the worker process (prevents recursive hook injection) |

**Env precedence**:
- `TRELLIS_CHANNEL_PROJECT` set externally → that bucket (advanced)
- `TRELLIS_CHANNEL_PROJECT` not set → derive from `process.cwd()`
- `selectExistingChannelProject(name)` may **mutate `process.env.TRELLIS_CHANNEL_PROJECT`** when falling back to a unique cross-bucket match, so the rest of the CLI invocation lands on the same bucket

---

## 4. Validation & Error Matrix

### CLI-level

| Condition | Behavior |
|-----------|----------|
| `create <name>` and channel exists, no `--force` | throw `"Channel '<name>' already exists at <dir>. Use --force to overwrite."` |
| `create --force` with live workers | killLiveWorkers (SIGTERM → 1.5s → SIGKILL) → rmrf → recreate |
| `spawn` and channel not found | throw `"Channel '<name>' not found at <dir>"` |
| `spawn` with no `--provider` and no `--agent` providing it | throw `"Missing --provider (and the agent definition has no \`provider:\` frontmatter)"` |
| `spawn` with no `--as` and no `--agent` providing fallback name | throw `"Missing --as (no agent name to fall back to)"` |
| `spawn` and worker name already has a live pid | throw `"Worker '<as>' is already running in channel '<name>' (pid <N>)"` |
| `spawn` and `--provider` not in REGISTRY | exit 1, stderr `"--provider must be one of: claude, codex"` |
| `send` with none of `--stdin`/`--text-file`/`[text]` | throw (missing body) |
| `wait --all` without `--from` | throw `"--all requires --from <a,b,...>"` |
| `wait` timeout | exit 124; if `--all`, stderr `"timeout: still waiting on <csv>"` |
| `prune` with >1 of `--all/--empty/--idle/--ephemeral` | throw `"prune flags are mutually exclusive: <flags>. Pick one."` |
| `prune` without `--yes` | print candidates + `(dry-run)` notice; exit 0 without deleting |
| `run` worker exits with `error` or `killed` before `done` | exit 1, stderr `"channel kept for inspection: <path>"` |
| `selectExistingChannelProject(name)` channel exists in ≥2 buckets | throw `"Channel '<name>' exists in multiple project buckets: <csv>. Run from the owning project cwd or set TRELLIS_CHANNEL_PROJECT."` |
| `selectExistingChannelProject(name)` not found anywhere | throw `"Channel '<name>' not found in current project bucket (<key>) or any known project bucket"` |

### Supervisor-level

| Condition | Behavior |
|-----------|----------|
| `child.on("error")` before `child.once("spawn")` (ENOENT etc.) | emit ONE `error{message:"worker spawn failed: ..."}`, run `cleanup()`, `process.exit(1)` — NO `spawned` event |
| Duplicate `child.on("error")` fire after spawn-fail handled | guard with `if (spawnFailed) return` — no double event |
| Post-spawn `error` (worker died after start) | `await appendEvent({kind:"error", message})` THEN `await shutdown.request("SIGTERM", "crash")` — ordering enforced via async IIFE |
| Adapter handshake throws | `await appendEvent({kind:"error", detail:{source:"handshake"}, message})` THEN `shutdown.request("SIGTERM", "crash")` |
| Shutdown requested during `await spawnSettled` | after settle, check `shutdown.isShuttingDown()` — if true, `await shutdown.awaitFinalize()` and return (no `spawned` event written) |
| `child.on("exit")` and adapter never emitted done/error | `finalizeOnExit` synthesises `done{synthesized:true, exit_code:0}` (code=0) or `error{synthesized:true, exit_code, exit_signal}` (otherwise). `by` = worker name (NOT `supervisor:<worker>`) so `wait --from <worker>` wakes. |
| `child.on("exit")` and shutdown was requested | NO synthesis (`killed` event already serves as terminal). `finalizeOnExit` only `await killedPromise` then exits. |
| Kill ladder liveness check | `child.exitCode === null && child.signalCode === null` (NOT `child.killed` — that means "kill() called", not "process exited") |

### Security boundaries

| Surface | Validator | Reject behavior |
|---------|-----------|-----------------|
| Worker / channel name in protocol prompt | `safeIdentifier(s)` strips `/[\r\n\x00-\x08\x0b-\x1f\x7f]/` | silent strip (still produces a valid string) |
| `--file <path>` | `jailedRealpath(path, cwd)` requires `realpath(path).startsWith(realpath(cwd) + sep)` | skip file, stderr warn |
| `--jsonl <path>` | same jail | skip manifest entry, stderr warn |
| Symlink swap during read | `lstat` BEFORE `stat` to detect symlinks before resolve | treat as not found |
| `--agent <name>` | `/^[A-Za-z0-9._-]+$/` regex | throw |
| `--agent` resolved path | `realpath(path).startsWith(realpath(agentsRoot) + sep)` | throw |
| Frontmatter parse | `Object.create(null)`, reject keys in `["__proto__","prototype","constructor"]` | skip key |
| Context file per-file size | `MAX_PER_FILE_BYTES = 1_000_000` (1MB) | truncate + stderr warn |
| Context total size | `WARN_TOTAL_BYTES = 500_000` (500KB) | stderr warn (still loads) |

---

## 5. Good / Base / Bad Cases

### Case A — `channel run` happy path

**Good** (typical short task):
```bash
$ TRELLIS_CHANNEL_ROOT=/tmp/test trellis channel run --provider codex --message "say hi in 3 words"
Hi, glad you're here.
$ echo $?
0
$ ls /tmp/test/.../-tmp-*/run-*/   # ← channel removed after success
ls: ... No such file or directory
```

**Base** (normal CR with single worker):
```bash
$ trellis channel run --agent check --message-file /tmp/cr-brief.md --timeout 15m
## Files Checked
...
Issues Found
- ...
$ echo $?
0
```

**Bad** (provider missing → spawn-fail → channel kept for inspection):
```bash
$ PATH=/usr/bin trellis channel run --provider claude --message "hi" --timeout 30s
channel kept for inspection: /Users/.../-.../-run-4a520e0f
(ephemeral — will be removed by `channel prune --ephemeral`)
Error: timeout waiting for cx done
$ echo $?
1
# events.jsonl has [create, error] only — no spawned (correctly suppressed by pre-spawn guard)
```

### Case B — Multi-worker review with `wait --all`

**Good**:
```bash
trellis channel create cr-feature --ephemeral
trellis channel spawn cr-feature --agent check
trellis channel spawn cr-feature --agent check --provider codex --as check-cx
trellis channel send cr-feature --as main --to check --text-file brief.md
trellis channel send cr-feature --as main --to check-cx --text-file brief.md
trellis channel wait cr-feature --as main --kind done --from check,check-cx --all --timeout 15m
# stdout: two done event JSON lines (one per worker)
# exit 0 (both finished)
```

**Bad** (one worker times out):
```bash
trellis channel wait cr-feature --as main --kind done --from check,check-cx --all --timeout 30s
# stdout: only `done` from check (if any)
# stderr: "timeout: still waiting on check-cx"
# exit 124
```

### Case C — Cross-cwd addressing

**Good** (channel created in trellis repo, accessed from /tmp via unique-match fallback):
```bash
$ cd /Users/me/work/trellis && trellis channel create unique-name
$ cd /tmp && trellis channel send unique-name --as main --text "hi"
# selectExistingChannelProject finds unique-name in only one bucket → mutates env → succeeds
```

**Bad** (same name exists in multiple buckets):
```bash
$ cd /tmp && trellis channel send cr-r1 --as main --text "hi"
Error: Channel 'cr-r1' exists in multiple project buckets: -Users-me-work-trellis, -Users-me-work-vine. Run from the owning project cwd or set TRELLIS_CHANNEL_PROJECT.
```

### Case D — Spawn-fail event sequence

**Wrong** (pre-r5 behavior, never ship):
```
[create]
[spawned] pid=undefined        ← misleading, worker never started
[error]                        ← race with spawned
[killed]                       ← duplicate noise
# supervisor never exits (Node didn't emit `exit` for ENOENT)
```

**Correct** (post-r5):
```
[create]
[error] message="worker spawn failed: spawn claude ENOENT"
# supervisor process.exit(1); no spawned, no killed; pid file cleaned
```

---

## 6. Tests Required

| Surface | Test type | Assertion points |
|---------|-----------|-------------------|
| `paths.projectKey(cwd)` | unit | (a) `"/Users/x"` → `"-Users-x"`, (b) backslash → `-`, (c) CJK/spaces/`#` → `-`, (d) idempotent on re-sanitized input |
| `paths.migrateLegacyChannels()` | integration | (a) flat dir with events.jsonl → moves to `_legacy/<name>/`, (b) bucket marker dir → skipped, (c) `_legacy`/`_default` → skipped, (d) idempotent (no-op second call) |
| `paths.selectExistingChannelProject(name)` | integration | (a) current bucket has channel → returns currentProjectKey, (b) only one other bucket has it → mutates env + returns that bucket, (c) two buckets have it → throws with `Channel '<name>' exists in multiple` message, (d) none have it → throws with current bucket name in error |
| `appendEvent` atomicity | concurrent | spawn N parallel `appendEvent` calls; assert seqs are strictly monotonic 1..N with no duplicates or gaps |
| `withLock` stale-lock recovery | unit | write lockfile with dead-pid contents; subsequent `withLock` call recovers and proceeds |
| `watchEvents` modes | integration | (a) default reads from EOF, (b) `fromStart:true` reads from byte 0, (c) `sinceSeq:N` skips events with seq ≤ N |
| `matchesFilter` `to` semantics | unit | (a) event with no `to` passes when filter.to set (broadcast OK), (b) event with `to=X` only passes filter.to=X, (c) `filter.to="exclusive"` requires explicit `to` |
| Spawn-fail path (ENOENT) | e2e | `PATH=/no/claude trellis channel spawn ...` → events.jsonl has ONE error event, no spawned, no killed; supervisor exited; pid file removed |
| Happy turn (claude / codex) | e2e | spawn → send "hi" → wait done; assert events sequence is `create → spawned → message(to) → ...progress... → message(by:worker) → done` with no synthesised events |
| Cold-exit fallback synthesis | e2e | kill worker child PID directly (bypassing supervisor); assert `finalizeOnExit` synthesises terminal event with `by=workerName`, `synthesized:true` |
| Kill ladder | e2e | `channel kill`, assert events.jsonl has `killed{reason:"explicit-kill", signal:"SIGTERM"}` AND supervisor process gone within 6s |
| `markTerminalEmitted` race | concurrent | trigger adapter `done` and `child.on("exit")` near-simultaneously; assert exactly one terminal event (no duplicate synthesised one) |
| `wait --all` satisfaction | integration | spawn 2 workers, send each a prompt; `wait --all --from a,b --kind done`; assert exit 0 after both done events seen |
| `wait --all` timeout | integration | spawn 2 workers; kill one before it can done; `wait --all` exits 124 with `"timeout: still waiting on <killed-one>"` on stderr |
| `channel run` success cleanup | e2e | run happy; assert channel directory does not exist after exit |
| `channel run` failure preserves | e2e | run with bad provider; assert exit 1, stderr matches "channel kept for inspection:", channel directory still exists, `events.jsonl` has create+error |
| `--ephemeral` create + list + prune | integration | (a) `list` default hides, (b) `list --all` shows with `*`, (c) `list` footer prints "(N ephemeral channels hidden ...)", (d) `prune --ephemeral` only deletes ephemeral, (e) `prune --ephemeral --idle 1h` throws mutex error |
| Path-traversal jail | security | `--file /etc/passwd` from cwd `/tmp/work` → file skipped, stderr warn |
| Agent name validator | security | `--agent ../../evil` → throw |
| Frontmatter prototype pollution | security | `.trellis/agents/x.md` with `__proto__: ...` frontmatter → key dropped, no pollution observable |
| `safeIdentifier` | unit | newline / NUL / control chars stripped from worker name in protocol prompt |

---

## 7. Wrong vs Correct (key patterns)

### Pattern 1 — Marking adapter-emitted terminal events

**Wrong** (race with `finalizeOnExit`):
```ts
for (const ev of result.events) {
  await appendEvent(channelName, ev);     // ← worker process may exit during this await
  if (ev.kind === "done" || ev.kind === "error") {
    shutdown.markTerminalEmitted();        // ← too late; finalizeOnExit already synthesised a fallback
  }
}
```

**Correct** (sync-prepend the claim):
```ts
for (const ev of result.events) {
  if (ev.kind === "done" || ev.kind === "error") {
    shutdown.markTerminalEmitted();        // ← sync; finalizeOnExit observes this immediately
  }
  await appendEvent(channelName, ev);
}
```

### Pattern 2 — Post-spawn error handler ordering

**Wrong** (killed may land before error):
```ts
child.on("error", err => {
  void appendEvent({kind:"error", message: err.message});
  void shutdown.request("SIGTERM", "crash");   // ← runs in parallel; killed-append may win the lock
});
```

**Correct** (await error first, then request shutdown):
```ts
child.on("error", err => {
  if (spawnFailed) return;                    // L1 fix: defend against double-fire
  shutdown.claim("crash");                    // ← sync intent so concurrent code sees isShuttingDown
  void (async () => {
    try {
      await appendEvent({kind:"error", message: err.message});
    } catch { /* ignore — exiting anyway */ }
    await shutdown.request("SIGTERM", "crash");
  })();
});
```

### Pattern 3 — Liveness check in kill ladder

**Wrong** (`child.killed` is "kill() was called", not "process exited"):
```ts
setTimeout(() => {
  if (!child.killed) child.kill("SIGKILL");   // ← never fires, child.killed=true after first kill()
}, GRACE_MS);
```

**Correct**:
```ts
setTimeout(() => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}, GRACE_MS);
```

### Pattern 4 — Resolving a channel from a different cwd

**Wrong** (assumes current bucket):
```ts
const dir = channelDir(name);                 // ← uses cwd-derived bucket; throws if user is in /tmp
```

**Correct** (resolve before using paths):
```ts
selectExistingChannelProject(name);            // mutates TRELLIS_CHANNEL_PROJECT env if needed
const dir = channelDir(name);                 // ← now reads the locked env
```

### Pattern 5 — Synthesised terminal event author

**Wrong** (breaks `wait --from <worker>`):
```ts
await appendEvent({
  kind: "done",
  by: `supervisor:${workerName}`,             // ← wait --from worker --kind done won't wake
  synthesized: true,
});
```

**Correct**:
```ts
await appendEvent({
  kind: "done",
  by: workerName,                             // ← same `by` as adapter would have used
  synthesized: true,
});
```

---

## File Reference

```
commands/channel/
├── index.ts                  CLI Commander registration
├── create.ts                 channel create
├── spawn.ts                  channel spawn + supervisor fork
├── send.ts                   channel send
├── wait.ts                   channel wait (+ --all)
├── messages.ts               channel messages (+ --follow)
├── list.ts                   channel list (+ --all-projects / --all)
├── rm.ts                     channel rm + prune
├── kill.ts                   channel kill
├── run.ts                    channel run (one-shot wrapper)
├── supervisor.ts             supervisor process orchestrator
├── supervisor/shutdown.ts    ShutdownController state machine
├── supervisor/stdout.ts      line-pump + applyParseResult
├── supervisor/inbox.ts       inbox watcher + cursor
├── adapters/index.ts         WorkerAdapter REGISTRY + Provider type
├── adapters/types.ts         AdapterEvent / ParseResult shapes
├── adapters/claude.ts        Claude stream-JSON adapter
├── adapters/codex.ts         Codex app-server JSON-RPC adapter
├── store/paths.ts            project bucket helpers + migration
├── store/events.ts           appendEvent + ChannelEvent kind taxonomy
├── store/lock.ts             withLock (O_EXCL + stale-pid recovery)
├── store/watch.ts            watchEvents (fs.watch + poll fallback)
├── context-loader.ts         --file / --jsonl injection (jailed realpath)
└── agent-loader.ts           --agent loader (frontmatter parse + path jail)
```

---

## Future work (not in scope of this spec)

- **`StorageAdapter` abstraction** for cloud-backed stores (S3 / DynamoDB / Redis). Today `store/*` calls `fs.*` directly; adapter pattern is the prerequisite for any non-local backend.
- **events.jsonl rotation** — triggers when single file > 100MB OR > 100k events. Schema split + reader-merge is the open design question.
- **Multi-tenant identity** — current model is single-user via `~/.trellis/`. Cross-user channels need an identity layer.
- **GUI frontend** consuming `events.jsonl` via fs.watch (Electron) or polling. CLI render rules in `messages.ts` translate directly.
