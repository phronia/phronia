---
name: phronia-coordinator
description: "Single-session multi-task orchestration: read a backlog, create tasks with footprints/dependencies, plan waves, dispatch a manifest through the harness's native sub-agents, monitor status, and integrate serially. Use for parallel task execution or coordinator-mode questions. Phronia never spawns agents itself."
---

# Coordinator Mode

Coordinate several independent tasks from one orchestrator session. This skill is an orchestration layer over the same task, worktree, lease, and integration primitives — it does not introduce a second execution model.

**Phronia does not spawn agents.** Phronia prepares tasks, workspaces, leases, and a dispatch manifest. Your harness's native sub-agent tool does the dispatch.

## Capability Gate (do this first)

```bash
phronia task parallel status --platform <platform-id> --json
# or
phronia task coordinator status --platform <platform-id> --json
```

Read `capabilities.coordinator`:

- `available: true` — coordinator mode is supported; continue.
- `available: false` — read `reason` and `fallback`. Do **not** create a batch or pretend to dispatch. Use the fallback.

If the platform is unknown, the gate fails closed with `COORDINATOR_UNSUPPORTED` / `multi-session`. Never assume a harness supports parallel sub-agents with per-task workspaces.

### Current capability matrix

| Harness | Coordinator | Fallback |
|---|---|---|
| Claude Code | candidate (`subagentExecution=nested`, `subagentWorkspace=per-task`, identity shared) | multi-session (`claude --worktree`) |
| ZCode | unsupported | multi-session: one window/worktree per task, or serial |
| Codex | unsupported (sub-agents inherit cwd) | multi-session (`codex exec -C <worktree>`) or serial |
| Unverified class-1 platforms | unknown → unsupported | multi-session or serial |
| No sub-agent surface (Gemini, Copilot, Qoder, Trae, Grok, Kimi, DSH, Kilo, Antigravity, Devin, Reasonix) | unsupported | planner + manual sessions, or serial |

`subagentIdentity=shared` (Claude Code) means every command must pass an explicit `--task <ref>`; never rely on the session's active-task pointer.

### Fallback: multi-session or serial

When the gate is unavailable:

1. For each task: `phronia task workspace ensure <ref> --json` (or `workspace prepare --for-new-task "<title>"` before the task exists).
2. Start one agent session per worktree, with the prompt prefix:
   ```
   Active task: <task-ref>
   Work only in <workspace-path>.
   Commit in this worktree with `phronia task commit <task-ref>` when done.
   ```
3. Do not run two tasks in the same checkout. If the harness inherits cwd, that is the whole reason to use separate sessions.
4. Serial alternative: dispatch one task at a time in the same session.

### ZCode / Codex: the multi-session four steps

Neither harness can move a sub-agent into another `cwd`, so dispatch admission
will refuse an isolated task in the main checkout. Do this instead:

1. `phronia task workspace ensure <task-ref> --json` — creates the worktree on
   `phronia/<slug>` or reuses an existing one.
2. Open a new window/session in the printed path (`codex`: `codex exec -C <path>`).
3. Make the first prompt line `Active task: <task-ref>`; do not rely on the
   ambient task pointer inherited from the coordinator session.
4. When the work is committed in that worktree, run
   `phronia task integrate <task-ref>` in the coordinator session.

Run at most one task per checkout. The task lease and workspace claim are what
make a second writer visible.

### Pre-dispatch checklist (maps to `DISPATCH_*`)

Before dispatching `phronia-implement` / `phronia-check`, verify:

- [ ] the task is not a parent (`task.json.children` is empty) — otherwise
      `DISPATCH_PARENT_TASK`;
- [ ] `task.json.status == "in_progress"` — otherwise
      `DISPATCH_TASK_NOT_IN_PROGRESS`;
- [ ] an explicit `Active task:` names the active task or one of its children —
      otherwise `DISPATCH_TASK_NOT_CHILD`;
- [ ] the session cwd is the task's worktree when it has one — otherwise
      `DISPATCH_WRONG_CHECKOUT`;
- [ ] a linked worktree is registered to this task, not another —
      otherwise `DISPATCH_CHECKOUT_OWNED_BY_OTHER`;
- [ ] a task that needs isolation (`parallel.worktree=always`, `exclusive`, or
      ≥2 `in_progress` siblings) is dispatched from its worktree — otherwise
      `DISPATCH_ISOLATION_REQUIRED`;
- [ ] main is unclaimed or claimed by this task — otherwise
      `DISPATCH_MAIN_CLAIMED`;
- [ ] a stale claim over a dirty main is resolved explicitly — otherwise
      `DISPATCH_STALE_CLAIM_DIRTY`.

`DISPATCH_NO_CLAIM`, `DISPATCH_LEASE_OTHER_OWNER`, and
`DISPATCH_PLATFORM_CANNOT_BLOCK` are allow-with-guard: dispatch may proceed,
but the sub-agent prompt starts with `WORKSPACE_GUARD` (and, on inject-only
harnesses, `STOP:`) telling it to get a workspace first.

## Flow

### 1. Read the backlog

Take the backlog directory or issue list from the user. For each candidate, extract: goal, acceptance signal, likely file/module surface, and hard dependencies. Group candidates that would touch the same files; they must not share a wave.

### 2. Create tasks and declare the surface

```bash
python3 ./.phronia/scripts/task.py create "<title>" --description "<what it delivers>" --slug <name>
```

Then declare the parallel metadata in each task's `task.json`:

```json
{
  "meta": {
    "parallel": {
      "touches": ["src/ui/progress/**"],
      "depends_on": ["10-28-other-task"],
      "worktree": "auto"
    }
  }
}
```

`relatedFiles` is also accepted as a footprint source. Rules:

- Unknown footprint → the task is scheduled alone. Do not guess.
- `depends_on` is the only dependency source; parent/child structure is not a dependency.
- Dependency cycles are refused (`DEPENDENCY_CYCLE`).
- Shared/generated files (`pnpm-lock.yaml`, `.phronia/config.yaml`, `.phronia/spec/**`, `docs/requirements.md`, migrations) are always-serial.

Tasks created in a linked worktree are branch-local until integrated; create/plan coordinator tasks in the main checkout.

### 3. Plan

```bash
phronia task parallel plan --explain --json
```

Use the waves and the per-task reasons. If the plan reports `unknown_footprint`, declare the surface and re-run. If it refuses a cycle, print the cycle path and ask the user to break it — do not silently drop tasks.

### 4. Dispatch

Start with a dry run to see the resolved manifest without creating worktrees or leases:

```bash
phronia task parallel dispatch --batch <id> --wave <n> --dry-run --json
```

Then the real dispatch (creates/attaches workspaces and acquires task leases):

```bash
phronia task parallel dispatch --batch <id> --wave <n> --json \
  --session-key <coordinator-session-key> --owner-id <owner-id>
```

The manifest contains, per task: `taskRef`, `workspace`, `branch`, `lease`, `dependsOn`, `promptPrefix`. A batch summary is written under `<git-common-dir>/phronia/batches/<id>.json`.

**Dispatch each manifest entry with the harness's native sub-agent tool** (Claude Code: the Agent/Task tool with `cwd: <workspace>`). The prompt must:

1. start with the manifest's `promptPrefix` (it begins `Active task: <ref>`), then
2. state the workspace path and that all work happens there,
3. require checks and `phronia task commit <ref>` inside that worktree,
4. forbid the sub-agent from touching the main checkout or other tasks' worktrees.

Skipped entries are reported with a `code` and `next`; do not invent a workspace for them.

### 5. Monitor

```bash
phronia task coordinator status --batch <id> --json
phronia task parallel status --json
```

- `queued` / `running` / `blocked` / `landed` / `needs_human` aggregate the batch.
- A failed sub-agent marks its task `blocked`; other tasks continue. Retry that task after fixing the cause.
- A stale task lease is reported with the exact release/reclaim command; nothing is auto-reclaimed.
- Do not hold the main checkout's claim while coordinating. Local integrate needs `main`.

### 6. New sessions joining mid-batch

A new session may create a task at any time:

1. It creates the task and declares its footprint (registration in the shared index is automatic).
2. Re-run `phronia task parallel plan --explain` in the orchestrator.
3. A non-overlapping task joins the next wave or a free slot; an overlapping task waits. There is no global batch lock — only task leases and the integration lock.
4. Blocked tasks stay out of the wave until retried.

### 7. Integrate and finish

After the batch's work is committed in each worktree:

```bash
phronia task integrate --drain          # FIFO over queued tasks
# or, per task:
phronia task integrate <ref>
```

Integration is serial by design: one shared lock per repository. `integrate` is not archive — it records `meta.integration.outcome` (`landed` / `pushed` / `blocked` / `needs_human`). Once landed, run ``finish-work` (Phronia command)` per task to archive and clean up the landed worktree.

For remote-mode batches, Phronia pushes and opens PRs but never merges; the forge's merge queue owns ordering.

## Hard Rules

- Never start an agent process from Phronia. `dispatch` only emits a manifest.
- Never dispatch a task whose workspace or lease is missing (`COORDINATOR_DISPATCH_INVALID`).
- Never assume an unverified harness is supported. Fail closed and print the fallback.
- Never rely on the ambient active-task pointer in coordinator mode; pass `--task` explicitly.
- Never archive a task whose integrate failed, whose worktree is dirty, or whose outcome is not `landed`.
- Never parallelize tasks with overlapping footprints or an explicit user dependency.
