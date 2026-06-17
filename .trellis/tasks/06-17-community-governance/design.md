# Design — GitHub Community Governance (Phase 1)

## Architecture

```
.github/
├── CONTRIBUTING.md            # entry point — short, scannable
├── PULL_REQUEST_TEMPLATE.md   # forced fields, AI-assist disclosure
├── CODE_OF_CONDUCT.md         # CC v2.1
├── ISSUE_TEMPLATE/
│   ├── bug.yml                 # required-field issue form
│   ├── feature.yml             # includes platform-support checkbox
│   └── config.yml              # blank_issues_enabled: false, route to Discussions
└── workflows/
    └── triage.yml              # auto-label + stale-close

SECURITY.md                    # private disclosure via GH Security Advisories
ROADMAP.md                     # thin, points at Projects board
```

## File contracts

### `.github/CONTRIBUTING.md` (≤ 300 lines)

Sections (in order):
1. Welcome (3 lines).
2. **Non-goals** (Prettier pattern) — what we will *not* accept.
3. Setup: `pnpm install`, `pnpm test`, `pnpm lint`, `pnpm dev`.
4. Conventional commit table (feat/fix/docs/refactor/perf/test/build/ci/chore/revert) with example PR titles.
5. PR workflow: branch from `main`, run tests, fill PR template, expect review within X days.
6. Triage flowchart (template → duplicate → reproduction → priority) — borrowed from Vite.
7. Project conventions: pointer to `.trellis/spec/` (not duplicated here).
8. Architecture entry point: pointer to architecture diagram.
9. AI-assistance disclosure: data only, no penalty.
10. Code of Conduct + Security pointers.

### `.github/PULL_REQUEST_TEMPLATE.md`

Required fields (each enforced by `triage.yml` body-check):
- **Summary** (1–3 sentences).
- **Linked issue** (`Closes #`).
- **Affected platforms** — checkbox list matching `architecture-diagram` vocabulary.
- **Affected layers** — checkbox list matching `architecture-diagram` vocabulary.
- **Test plan** — checklist.
- **AI authorship** — radio: Human / Human + AI assist / Agent-authored review. **Data collection only.**
- **Migration** (if applicable) — link to manifest.

### `.github/ISSUE_TEMPLATE/bug.yml`

GitHub Issue Form fields (all `required: true` unless noted):
- `description` — what happened.
- `repro_url` — minimal repro repo URL OR full `trellis init` transcript.
- `version` — output of `trellis --version`.
- `node_version` + `os` + `python_version`.
- `affected_platform` — dropdown (claude-code, cursor, opencode, iflow, codex, kiro, qoder, kilo, gemini-cli, antigravity, codebuddy, copilot, droid, pi, reasonix, windsurf, other).
- `expected_vs_actual`.
- Auto-applied labels: `bug`, `triage`, `needs-repro`.
- Footer: "Issues without reproduction are closed after 3 days of inactivity."

### `.github/ISSUE_TEMPLATE/feature.yml`

- `problem` (1–3 sentences, no solution).
- `proposed_solution` (optional).
- `affected_scope` — multi-select: cli, configurators (which platforms), templates, hooks, docs, spec.
- `platform_support_request` — checkbox: "Is this a request to add a new AI platform?" + name field.
- Auto-applied label: `enhancement`, `triage`.
- Note: "Large or breaking proposals → discuss in Discussions > Ideas first."

### `.github/ISSUE_TEMPLATE/config.yml`

```yaml
blank_issues_enabled: false
contact_links:
  - name: Question / Support
    url: https://github.com/<org>/Trellis/discussions/categories/q-a
    about: Ask in Q&A — keeps Issues for confirmed bugs.
  - name: Idea / RFC-track Proposal
    url: https://github.com/<org>/Trellis/discussions/categories/ideas
    about: For larger or breaking proposals before opening an Issue.
  - name: Security Disclosure
    url: https://github.com/<org>/Trellis/security/advisories/new
    about: Private disclosure via GitHub Security Advisories.
```

### `.github/CODE_OF_CONDUCT.md`

Contributor Covenant 2.1 verbatim + Trellis enforcement contact (must be a real person, named in PRD's open question).

### `SECURITY.md`

- Supported versions: current minor + previous minor.
- Disclosure: GH Security Advisories link.
- Response SLA: acknowledge within 5 business days.
- Scope: CLI execution paths, template installation, hook injection points, marketplace ingestion.

### `ROADMAP.md` (≤ 80 lines)

```markdown
# Roadmap

Live state: <link to GitHub Projects v2 board>.

## Now (in flight)
- (3–7 items, each links to a tracking issue)

## Next (committed for the upcoming minor)
- (3–7 items)

## Later (intent without commitment)
- (3–7 items)

## Non-goals
- (explicit list of things we will not pursue this cycle)

## Updates
Refreshed each minor release; column moves happen as issues move on the Projects board.
```

### `.github/workflows/triage.yml`

Triggered on: `issues: [opened]`, `pull_request: [opened, edited]`.
Jobs:
- `label-by-template`: parse the form / template type → apply label.
- `stale-needs-repro`: uses `actions/stale@v9` with `needs-repro` → close after 3 days, exempt label `repro-provided`.
- `pr-required-fields`: parse PR body, post a comment if Summary / Linked Issue / Test plan / AI authorship missing.

## Vocabulary lock

The PR template's "Affected platforms" and "Affected layers" checkboxes must match the `architecture-diagram` task's glossary verbatim. If diagram doesn't ship in time, freeze a draft glossary in this task's `notes/vocabulary.md` and reconcile during diagram review.

## Tradeoffs

| Decision | Picked | Alternative | Why |
|----------|--------|-------------|-----|
| 3 Discussion categories | Q&A, Ideas, Show & Tell | 6 categories per research recommendation | Volume doesn't justify 6 yet; promote later. |
| 1 issue template per type | bug + feature only | bug + feature + platform-support + 3 more | Each extra template = maintenance + decision overhead. |
| AI-disclosure non-punitive | Data only | Block PRs without disclosure | Hostile to audience. Re-evaluate when we have data. |
| GH Projects = roadmap | Yes | Static ROADMAP.md only | Live state without `git commit` for status changes. |
| Stale-bot only on `needs-repro` | Yes | Stale-bot on all triage | Don't kill long-open feature requests; targeted close only. |
| GH Security Advisories | Yes | Custom email + PGP | Solo maintainer; Advisories is the lowest-overhead private channel. |
| `Signed-off-by` default | Yes | CLA bot | Bot adds friction; can switch later. |

## Data flow

1. User clicks "New issue" → sees only Bug / Feature forms (config.yml blocks blank).
2. Form submits → `triage.yml` auto-labels.
3. Maintainer daily 5-min pass: confirm template, set priority `p1`–`p5`, link related issues.
4. Weekly 15-min sweep: move triaged items onto Projects board, promote Ideas with engagement to Issues, close stale `needs-repro`.
5. PR opened → template required → `triage.yml` checks body for required fields → CI runs tests → maintainer reviews.

## Anti-bias / honesty measures

- CONTRIBUTING.md never references humans/roles that don't exist.
- All "we" claims in CONTRIBUTING are scope-bounded ("the maintainers" not "the team").
- If the AI-disclosure clause changes (e.g. starts enforcing), require a PR and a Discussion poll first.

## Rollback / fail-soft

- Phase 1 can ship one file at a time if needed; CONTRIBUTING.md first, the rest in a follow-up if review bandwidth is tight.
- If triage automation goes wrong (mislabels, false stale-closes), disable the workflow file; manual triage continues to work.
- If issue forms feel too heavy after a month, downgrade to free-text Markdown templates.

## Dependencies

- `architecture-diagram` for vocabulary lock.
- One real human committed as CoC contact (open question).
- License confirmed and in `LICENSE` file.
