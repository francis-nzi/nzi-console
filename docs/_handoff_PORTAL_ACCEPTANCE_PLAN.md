# Acceptance plan — Portal plan + Portal SRS readiness (staging)

Closes NZC-080. The two portal surfaces — plan (#173) and readiness (#177) — reached staging without
the formal acceptance pass every other Phase 2 surface got. This is that pass: populate a staging
client, view the portal **as that client**, check each surface against its brief's acceptance criteria,
and record the result as `STAGING_ACCEPTANCE_PORTAL_PLAN.md` and `STAGING_ACCEPTANCE_PORTAL_READINESS.md`,
matching the house format. A gate is not an acceptance — this is what makes them accepted.

## Prerequisite — populate a staging client (the smoke test found the table empty)
Pick one client (Bushy Tails or demo-nzi-console) and, via the staff console (which also exercises the
entry paths) or a seed, give it:
- **≥3 reduction strategies across ≥2 levers**, `include_in_report = true`, with **target dates** — at
  least one due-soon, one overdue, and **one undated** (to test the honest "no date" case); varied
  status/progress; at least one **bespoke** (no library description); at least one carrying a **reduction
  estimate** (to see the estimate linkage if surfaced).
- **At least one strategy `include_in_report = false`** — to prove it's hidden from the portal.
- **A withdrawn/deactivated strategy aligned to a gap** — to prove it's excluded from the reverse link.
- **A completed SRS assessment (not draft)** with a mix of met/gap requirements across pillars: at least
  one gap **addressed by a client strategy**, and at least one gap with **no strategy** (honest marker).
- Feature flags `portal-plan` + `portal-readiness` present (now gated).
Then open the portal **as that client** (portal auth).

## Portal plan (#173) — criteria
- Shows `include_in_report = true` strategies, grouped by lever; withdrawn-lever → "Other".
- Per strategy: title, description (**library only** — bespoke shows none), control-level chip, scope,
  status, progress, target date + due state (**matches the #164 signals exactly**), SRS alignment.
- **Owner not shown** (internal handle).
- **LIVE:** make a workspace edit, reload the portal, confirm it appears (not a snapshot).
- Excluded (`include_in_report = false`) strategies **absent**.
- Honest empty state when a client has no plan; **no invented dates**.
- Read-only — no edit controls reachable.
- **Gate:** with the `portal-plan` token removed, the surface is hidden; restored, it returns.

## Portal readiness (#177) — criteria
- Overall + per-pillar maturity + **shortfall-ordered** gaps, **LIVE** (re-assess, reload, confirm the
  score moves).
- Per gap: addressing client strategies (live reverse link), **withdrawn excluded**,
  `include_in_report`-filtered; honest "no strategy aligned yet" when none.
- **Draft assessment not shown** — only a completed one; a client mid-assessment sees "in progress".
- **No internal assessment notes** leaked.
- Read-only, tenant-scoped.
- **Gate:** with the `portal-readiness` token removed, hidden; restored, it returns.

## Cross-checks
- **Tenant isolation:** the client sees only their own org's plan + readiness (verify with a second
  client if one's available).
- Both surfaces render in the portal theme; dd/mm/yyyy; and read coherently side by side
  ("where I stand + what I'm doing").

## Sign-off
- Record each surface's criteria checked (with screenshots, date, who ran it) in its
  `STAGING_ACCEPTANCE_PORTAL_*.md`.
- Flip the NZC-080 backlog rows from "⚠️ still owes acceptance" to **accepted**, citing the docs.
- Any criterion that fails → a fix PR, then re-run that criterion.

## Who does what
- **Data setup:** staff console (consultant enters strategies + estimates; assessor completes an
  assessment) or a Claude Code seed — console UI is preferable as it also exercises entry.
- **Viewing the portal:** Francis (portal auth).
- **Claude Code:** can produce the two `STAGING_ACCEPTANCE_PORTAL_*.md` templates with these checklists
  pre-filled, ready to tick.
- NZC-069 held.
