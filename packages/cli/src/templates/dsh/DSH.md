# Phronia on DeepSeek Harness (dsh)

dsh is a **class-2 pull-based** Phronia host: no session-start hook auto-injects
workflow context, so the agent loads the Phronia skills on demand through its
skill-loader tool.

| Capability | Status |
| --- | --- |
| Skills (`.agents/skills/phronia-*/SKILL.md`) | Works — dsh discovers this shared root natively |
| Entry skills (`.dsh/skills/phronia-*/SKILL.md`) | Works — dsh's own project skill root (highest rank) |
| Context hooks | None — pull-based: skills read `.phronia/` files directly |
| Sub-agents | None shipped — implement/check/research run inline via the workflow skills |

## Quick start

```bash
phronia init --dsh -u your-name
dsh web        # or: dsh --profile headless "start a Phronia task for ..."
```

In dsh:

1. Open a session in the project root and describe the work in natural
   language. For a new task the agent should load the `phronia-start` skill,
   which reads the current task state from `.phronia/` and routes to
   `phronia-brainstorm` (unclear requirements), `phronia-before-dev` (about to
   write code), `phronia-check` (done coding), or `phronia-update-spec`
   (learned something worth capturing).
2. Entry skills are `phronia-start` / `phronia-continue` / `phronia-finish-work`
   in `.dsh/skills/`. You can also ask for them by name at any time.
3. Type `/phronia:finish-work` is a slash-command convention from other hosts —
   dsh has no slash palette, so say "finish the phronia task" instead, and the
   agent loads `phronia-finish-work`.

## File map

- `.agents/skills/` — auto-triggered workflow skills (`phronia-before-dev`,
  `phronia-brainstorm`, `phronia-check`, `phronia-break-loop`,
  `phronia-update-spec`) plus the bundled `phronia-meta` /
  `phronia-spec-bootstrap` / `phronia-session-insight` skills. Byte-identical
  to Codex / Gemini CLI / Pi / Kimi writes into the same shared root.
- `.dsh/skills/` — dsh-private entry skills (`phronia-start` /
  `phronia-continue` / `phronia-finish-work`).
- `.phronia/` — specs, tasks, workspace memory, and the shared scripts the
  skills invoke (`get_context.py`, `task.py`, ...).

## Notes

- Skill scripts pass `--platform dsh` to `get_context.py`; the value is used
  as a platform-scoped context key.
- The shipped `minimal` agent preset composes only `bash` +
  `str_replace_editor`; the default presets include `web_search` and the
  filesystem/terminal tools the skills assume.
- dsh has no project-level sub-agent definition surface, so Phronia ships no
  `phronia-implement` / `phronia-check` / `phronia-research` agent prompts
  here — the workflow skills run those phases inline in the main session.
