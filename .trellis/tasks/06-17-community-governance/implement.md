# Implement — Community Governance (Phase 1)

Ordered. Resolve all open questions in PRD before Phase 1.0.

## Phase 0 — Inputs (no commits yet)

- [ ] 0.1 Run `gh api` to count opened issues + PRs in the last 90 days (input: closed + open). Record in PRD.
- [ ] 0.2 Confirm Trellis license. If LICENSE file exists, note it; if not, add (default MIT pending user confirm).
- [ ] 0.3 User names a real human as CoC enforcement contact + their email/handle.
- [ ] 0.4 Wait for `architecture-diagram` to publish layer + platform vocabulary, OR draft `notes/vocabulary.md` here for later reconciliation.
- **Gate**: all four resolved before writing artifacts.

## Phase 1 — Author artifacts (one PR per cluster)

### 1.1 Foundation (single PR)
- [ ] `LICENSE` (if missing)
- [ ] `.github/CODE_OF_CONDUCT.md`
- [ ] `SECURITY.md`
- [ ] `README.md` updates: link to CONTRIBUTING + Code of Conduct + Security

### 1.2 Contributor entry (single PR)
- [ ] `.github/CONTRIBUTING.md`
- [ ] `ROADMAP.md`

### 1.3 Issue + PR templates (single PR)
- [ ] `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] `.github/ISSUE_TEMPLATE/bug.yml`
- [ ] `.github/ISSUE_TEMPLATE/feature.yml`
- [ ] `.github/ISSUE_TEMPLATE/config.yml`

### 1.4 Automation (single PR)
- [ ] `.github/workflows/triage.yml`
- [ ] Manually create GitHub Projects v2 board with Now / Next / Later columns.
- [ ] Manually enable Discussions; create Q&A, Ideas, Show and Tell categories.

## Phase 2 — Validate

- [ ] 2.1 Open a test bug issue without reproduction → confirm form rejects empty repro field, label `needs-repro` applied.
- [ ] 2.2 Open a test PR with missing fields → confirm `triage.yml` bot-comment posts.
- [ ] 2.3 Confirm "New issue" page hides blank issue option and shows Q&A / Ideas / Security links.
- [ ] 2.4 Wait 4 days, confirm test `needs-repro` issue auto-closes.
- [ ] 2.5 Cross-link from architecture-diagram README and benchmark-showcase ROADMAP entry.

## Phase 3 — Wrap

- [ ] 3.1 Announce in Discussions > Announcements: "Contribution flow updated."
- [ ] 3.2 Record Phase 2 + 3 trigger thresholds in `ROADMAP.md` Later column.
- [ ] 3.3 task.py finish + archive.

## Validation commands

```bash
gh issue list --state all --search "created:>$(date -v-90d +%Y-%m-%d)" --json number | jq length
gh pr list --state all --search "created:>$(date -v-90d +%Y-%m-%d)" --json number | jq length
gh api repos/:owner/:repo/labels --jq '.[] | .name'
gh workflow list
```

## Rollback points

- If `triage.yml` mislabels or false-stale-closes: disable the workflow file in `.github/workflows/`; manual triage continues.
- If issue forms feel too heavy after a month: downgrade `bug.yml`/`feature.yml` to Markdown templates.
- If a Phase 1 PR draws scope-creep into Phase 2 territory (governance, RFC), close + split.

## Out-of-scope reminder

If any of these come up during implementation, push back and file as new tasks:
- GOVERNANCE.md, RFC funnel → Phase 2 task.
- Changesets, auto-changelog → Phase 3 task.
- CLA bot, trademark policy → Phase 2 task.
- More Discussions categories → revisit at next quarterly review.
