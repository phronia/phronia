# GitHub Community Governance

## Goal

Establish the **minimum-credible** public-OSS governance surface for Trellis so external contributors know how to file issues, propose work, get PRs reviewed, and follow our roadmap — without smothering 1–2 maintainers with process.

## Why now

PR activity is currently ad-hoc and will collapse under volume once we publicize. The fix is not to copy a 5-maintainer project's full ceremony but to ship a phased minimum, sized to actual issue volume.

## Approach: phased rollout

Do **not** ship everything at once. Three phases, each gates on the previous landing cleanly:

### Phase 1 — Triage hygiene (this PRD)
The minimum to stop drowning. Ship together:
- `.github/CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/bug.yml`
- `.github/ISSUE_TEMPLATE/feature.yml`
- `.github/ISSUE_TEMPLATE/config.yml` (disable blank issues; route to Discussions)
- `.github/CODE_OF_CONDUCT.md` (Contributor Covenant 2.1)
- `SECURITY.md`
- `ROADMAP.md` (thin — pointer to GitHub Projects board + Now/Next/Later)
- GitHub Discussions enabled with 3 categories: **Q&A, Ideas, Show and Tell**
- One GitHub Action: `.github/workflows/triage.yml` (auto-label by template, stale-close `needs-repro` after 3 days)

### Phase 2 — Governance + RFC (later task)
Trigger: ≥2 outside maintainers active OR ≥10 active contributors.
- `GOVERNANCE.md` with roles + maintainer nomination + decision log location
- Discussions > Ideas template (`DISCUSSION_TEMPLATE/ideas.yml`)
- RFC funnel (skip 4-stage Astro process; use 2-stage: Discussion → accepted Issue → PR)

### Phase 3 — Changesets + roadmap board automation (later task)
Trigger: ≥3 releases/quarter or merge conflicts on CHANGELOG.
- Pilot changesets on a single 0.6.x patch first
- Migrate beta/rc/release scripts to changeset-driven flow
- Move ROADMAP.md to be auto-generated from Projects v2 board

**This PRD covers Phase 1 only.** Phases 2 and 3 will get their own tasks created when triggers hit.

## Scope (Phase 1)

**In scope** — all artifacts listed under Phase 1 above.

**Out of scope (explicit)**
- `GOVERNANCE.md` (phase 2)
- RFC process (phase 2)
- Changesets adoption (phase 3)
- Separate `trellis-roadmap` repo (premature)
- `platform-support.yml` issue template (fold into feature.yml as a checkbox)
- 4-stage RFC funnel (phase 2 minimum)
- Maintainer nomination process (phase 2, when there's >1 person)
- "Champions" concept (phase 2)
- Per-platform pinned Discussions (would be ghost towns at current volume)
- Discord / Slack (no bandwidth to moderate)
- CLA / DCO decision (decide in phase 2)
- `maintainers@trellis` email (no one to monitor)

## Constraints

- **Maintainer count**: realistically 1 person right now. All process must be doable solo.
- **Issue volume baseline**: must be measured (last 90 days) before triage cadence is set. PRD will be amended with numbers.
- **AI-disclosure stance**: data collection only in v1, **no enforcement penalty**. Trellis's audience IS AI-assisted; hostile framing repels users.
- **Language**: keep CONTRIBUTING.md welcoming and short (target ≤ 300 lines). Long docs are dead docs.

## Reference projects (graded for borrowing)

| Project | Borrow | Skip |
|---------|--------|------|
| OpenHands | AI-vs-Human PR checkbox, lightweight maintainer process | Slack channels per workstream |
| Astro | changesets pattern (phase 3), simple stage funnel | Separate roadmap repo, 4 stages |
| Vite | Triage flowchart, p1–p5 priority labels, stale-close on needs-repro | High-volume rotation cadence |
| Biome | AI-disclosure as norm, odd/even semver consideration | Strict enforcement language |
| Vitest | "Real person via official templates" rule | Hostile anti-AI framing |
| Continue | "Open issue before coding" rule, GitHub Projects = roadmap | Discord-as-primary |
| Prettier | Per-PR changelog snippet pattern (phase 3), non-goals doc | Heavy enforcement |
| Nx | Issue forms over free text, `affected` style targeted CI | Plugin marketplace ceremony |

## Acceptance Criteria

- [ ] All Phase 1 artifacts merged on `main`.
- [ ] Bug issue forms reject submission without reproduction.
- [ ] PR template includes: scope, affected platforms checkbox (matching architecture-diagram vocabulary), affected layers checkbox, test plan, AI-assistance disclosure (data only).
- [ ] CONTRIBUTING.md includes:
  - Non-goals section.
  - Conventional commit table.
  - Setup commands (`pnpm install`, `pnpm test`, `pnpm lint`).
  - Pointer to `.trellis/spec/` for project conventions.
  - Pointer to architecture diagram (dep on `architecture-diagram` task).
  - Pointer to `SECURITY.md` and Code of Conduct.
- [ ] `ROADMAP.md` ≤ 80 lines: Now / Next / Later headers + link to GitHub Projects board + non-goals.
- [ ] GitHub Projects v2 board exists with Now / Next / Later columns, seeded with current in-flight tasks.
- [ ] Discussions enabled with 3 categories, blank issues routed to Q&A.
- [ ] `triage.yml` GitHub Action runs and auto-labels new issues by template type.
- [ ] Stale-bot configured: `needs-repro` → close after 3 days no activity.
- [ ] Last-90-days issue / PR volume measured and recorded in PRD; triage cadence written to match (likely daily 5-min + weekly 15-min, NOT 30-min sweep).
- [ ] No process file references humans / emails that don't actually exist.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Governance theater | Phase 1 only ships docs that match actual capacity; no fake roles. |
| Process burden killing velocity | Hard cap: total time to triage one issue ≤ 2 min. |
| Hostile AI framing | Disclosure clause is data-only; no penalty. |
| Stale roadmap | Auto-pull from Projects board (phase 3) or quarterly review item. |
| Two competing decision logs | CONTRIBUTING.md explicitly says `.trellis/spec/` is conventions; future GOVERNANCE.md will be decisions. |
| Empty per-platform discussions | Use single "Platform Support" Q&A tag, not separate categories. |

## Open questions (pre-implementation)

- [ ] Issue + PR volume for the last 90 days? (need git history + GH API to count)
- [ ] License of Trellis confirmed (MIT? Apache-2.0?) and stated in CONTRIBUTING + LICENSE.
- [ ] CLA vs DCO decision — defer to phase 2, but record default behavior (assume DCO via `Signed-off-by` until decided).
- [ ] Trademark policy on "Trellis" name + marketplace items — defer to phase 2 but flag.
- [ ] Whose Code of Conduct enforcement contact? (need real person until phase 2).

## Dependencies

- `architecture-diagram` must publish layer names before PR template's "affected layers" checkbox can be finalized — single shared vocabulary.
- No `benchmark-showcase` dep: that task is internal (`tmp/`), nothing flows into ROADMAP.md.
