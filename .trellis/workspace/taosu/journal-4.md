# Journal - taosu (Part 4)

> Continuation from `journal-3.md` (archived at ~2000 lines)
> Started: 2026-03-13

---



## Session 102: Publish-Skill Command & Docs-Site Sync

**Date**: 2026-03-13
**Task**: Publish-Skill Command & Docs-Site Sync
**Package**: cli

### Summary

(Add summary)

### Main Changes

| Feature | Description |
|---------|-------------|
| docs-site submodule | Updated submodule ref to include cc-codex-spec-bootstrap skill pages |
| /trellis:publish-skill | New slash command automating marketplace skill → docs-site sync workflow |

**Details**:
- Created `/trellis:publish-skill` command (9-step workflow: identify skill, check existing, create EN/ZH pages, update indexes, update docs.json, commit/push docs, ensure skill on main, confirm)
- Available in both `.claude/commands/trellis/` and `.cursor/commands/`
- Committed docs-site submodule ref update from earlier skill documentation work

**Files Created**:
- `.claude/commands/trellis/publish-skill.md`
- `.cursor/commands/trellis-publish-skill.md`


### Git Commits

| Hash | Message |
|------|---------|
| `d8d7dfb` | (see git log) |
| `b93ef30` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 103: Rename empty templates to from scratch

**Date**: 2026-03-16
**Task**: Rename empty templates to from scratch
**Package**: cli

### Summary

Renamed 'empty templates' label to 'from scratch' in trellis init template picker (3 files: init.ts, create_bootstrap.py, create-bootstrap.sh). Internal value 'blank' unchanged. Onboard templates not affected (different concept).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `57a243d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 104: Decouple .agents/skills as shared layer + Codex .codex support

**Date**: 2026-03-24
**Task**: Decouple .agents/skills as shared layer + Codex .codex support
**Package**: cli
**Branch**: `feat/v0.4.0-beta`

### Summary

Major architecture change: decoupled .agents/skills/ from Codex platform into shared Agent Skills layer, added full .codex/ directory support with hooks, skills, and agents

### Main Changes

## Changes

| Area | Details |
|------|---------|
| Architecture | `.agents/skills/` decoupled from Codex, now shared (agentskills.io standard) |
| Type System | `extraManagedPaths` → `supportsAgentSkills` flag, codex `configDir` → `.codex` |
| Detection | Platform detection uses `.codex/` only, `.agents/skills/` alone ≠ codex |
| `.codex/` | New: config.toml, agents/*.toml, skills/parallel/, hooks/session-start.py, hooks.json |
| Python CLIAdapter | `config_dir_name` → `.codex`, `requires_agent_definition_file`, `supports_cli_agents` |
| Migration | Legacy Codex auto-upgrade via template-hashes, safe-file-delete for old files |
| Hooks | Codex SessionStart hook injecting full Trellis context (verified working) |
| Agent TOML | Fixed format to `name` + `description` + `developer_instructions`, renamed to convention |
| PR #112 | iFlow --agent regression fixed, workspace artifacts cleaned |
| Cleanup | Removed unused test/scripts/ Python tests |

## Key Decisions
- `.agents/skills/` = shared layer (8+ CLIs use it)
- `.codex/skills/` = Codex-specific skills (e.g. parallel with --platform codex)
- SessionStart hook requires `codex_hooks = true` feature flag
- `suppressOutput` not implemented in Codex TUI (experimental limitation)
- Migration: detect legacy by template-hashes, not directory existence (avoids false positives)

## Tests
- 516 tests pass (26 files)
- 3 rounds of Codex cross-review, all findings addressed
- lint + typecheck clean
- Python copies verified identical

## Next
- Create migration manifest for release
- Update docs-site changelog
- Release 0.4.0-beta.8


### Git Commits

| Hash | Message |
|------|---------|
| `ba75c30` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
