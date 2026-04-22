# PRD: Qoder — split session-boundary commands from skills

## Problem

On Qoder, Trellis currently delivers **all** its workflows (start / finish-work / continue + brainstorm / before-dev / check / update-spec / break-loop) as auto-trigger skills under `.qoder/skills/{name}/SKILL.md`. Verified against current (0.5.0-beta.8) and 0.4.0 GA code:

- `packages/cli/src/configurators/qoder.ts` — only writes `.qoder/skills/` + `.qoder/hooks/` (0.5) / only `.qoder/skills/` (0.4)
- `packages/cli/src/templates/qoder/` — no `commands/` subdirectory

But Qoder's docs (`docs.qoder.com/zh/user-guide/commands`) confirm it **does** support Custom Commands:

- Typed with `/` in the Agent input
- Stored at `~/.qoder/commands/` (user-level) or `<project>/.qoder/commands/` (project-level)
- Supports Markdown-based custom prompt commands

This is an inconsistency with Trellis's command/skill design principle applied on every other platform:

| Primitive | Trigger | Purpose | Examples |
|---|---|---|---|
| **Command** | User (`/trellis:*`) | Session boundaries — explicit user entry | `start`, `finish-work`, `continue` |
| **Skill** | Platform (auto-match) | Phase-level workflows — AI picks based on intent | `brainstorm`, `before-dev`, `check`, `update-spec`, `break-loop` |
| **Sub-agent** | Main session (spawn) | Isolated roles | `implement`, `check`, `research` |

Qoder violates this: user-invoked session-boundary commands are buried in the skill-matcher along with AI-triggered workflows, so:

- User can't reliably invoke "start a session" — has to hope the skill matcher picks `start` skill based on their chat wording
- Skill matcher pollution — every platform turn has to consider 7–8 candidates instead of 5
- Inconsistency with peer platforms — Qoder users can't follow the same mental model they use on Claude Code / Cursor / OpenCode

## Goal

On Qoder, deliver Trellis in the correct two-layer form:

- **`.qoder/commands/trellis/*.md`** — session-boundary commands only: `start`, `finish-work`, `continue` (0.5) or `start`, `finish-work` (0.4)
- **`.qoder/skills/trellis-*/SKILL.md`** — auto-trigger workflows only: `brainstorm`, `before-dev`, `check`, `update-spec`, `break-loop`

User types `/trellis:start` or `/trellis:finish-work` explicitly when they want session boundaries. AI matches skills for workflow-level triggers.

## Proposed approach

1. **Verify Qoder Custom Commands file format** — likely Markdown with optional YAML frontmatter, but confirm against `docs.qoder.com/zh/user-guide/commands`. Check whether `.qoder/commands/<namespace>/<name>.md` with nested namespace is supported (like Claude Code's `trellis/` subdir) or if flat naming is required (like Cursor's `trellis-start.md`).
2. **Extend `qoder.ts` configurator**:
   - Read the canonical templates from `packages/cli/src/templates/common/commands/` (start / finish-work / continue)
   - Write them to `.qoder/commands/trellis/{name}.md` (or flat naming depending on step 1)
3. **Remove session-boundary templates from Qoder skills output**:
   - Drop `.qoder/skills/{start,finish-work,continue}/SKILL.md` from the generator — they stay as commands only.
   - Keep `.qoder/skills/{brainstorm,before-dev,check,update-spec,break-loop}/SKILL.md` — auto-trigger workflows.
4. **Migration manifest entry** for the upcoming release:
   - `rename` the three skills to commands for existing projects, OR
   - `safe-file-delete` the old skill files + write new commands (cleaner since the old skills trigger differently).
5. **Update docs-site**:
   - `ch13-multi-platform.mdx` §13.9 Qoder: commands table + skills list
   - `ch02-quick-start.mdx` Platform Configuration: `.qoder/commands/`, `.qoder/skills/`
   - `appendix-a.mdx` / `appendix-b.mdx`: add Qoder command rows

## Out of scope

- Migrating other skills-only platforms (Qoder is the only one that has native commands + we picked not to use them — other skills-only platforms like Kiro use skills because that's the platform's only UX surface)
- Changing 0.4 retroactively — fix goes into the next 0.5 beta; 0.4 users keep the skills-only behavior

## Acceptance criteria

- [ ] `packages/cli/src/configurators/qoder.ts` writes both `.qoder/commands/trellis/` (3 session commands) and `.qoder/skills/` (5 workflow skills)
- [ ] Running `trellis init --qoder` in a tmp dir produces the expected layout; file hashes match between fresh init and `trellis update`.
- [ ] Typing `/trellis:start` in Qoder's Agent input invokes the start command (live test, not just unit test).
- [ ] Migration manifest handles existing 0.5.0-beta.X installs (three skills → three commands) without leaving orphan skill dirs.
- [ ] `docs-site` beta + release tracks updated; `trellis-meta` skills-market entry (if it lists Qoder capability matrix) updated.
- [ ] Test `.qoder` directory under `.trellis/tasks/04-21-qoder-commands-skills-split/` (or a `tmp*` fixture) shows correct layout after dogfooding.

## Notes

- Confirmed symptom in `tmp1/.qoder/skills/` (2026-04-21): lists `trellis-start`, `trellis-finish-work`, `trellis-continue`, plus the five true auto-trigger workflows. Session-boundary ones shouldn't be there.
- Related user quote: "qoder 本身应该用那俩 command + 剩下的搞成 skill 吧" — yes, matches peer-platform convention.
- This is a P2 (design inconsistency, not breaking) but worth doing before 0.5 GA so the release doesn't ship with inconsistent Qoder UX.
