# Portal plan (#173) — acceptance record

Running record against `docs/_handoff_PORTAL_ACCEPTANCE_PLAN.md` and the surface's own brief,
`docs/_handoff_PORTAL_PLAN_VIEW_brief.md`. Closes half of **NZC-080**.

**This surface is already live on staging.** It shipped without the formal acceptance pass every
other Phase 2 surface got, and NZC-080 later gave it a rollout gate retrospectively. A gate is not
an acceptance — it is only the ability to withdraw. This record is what makes the surface
*accepted*, and until it is complete the backlog row keeps its "⚠️ still owes acceptance" marker.

> **Template — nothing below is ticked.** Fill in the run header, work down the boxes, and record
> the evidence. `☐` = not yet checked · `✅` = passed · `❌` = failed (raise a fix PR, then re-run
> that one criterion) · `n/a` = not reachable this run, with the reason written in.

## Run header

| | |
|---|---|
| Ran by | |
| Date (dd/mm/yyyy) | |
| Staging deploy (commit) | |
| Client used | |
| Portal account used | |
| `NEXT_PUBLIC_FEATURE_PORTAL` value at build time | |
| Screenshots folder / links | |

---

## Part 1 — data setup (prerequisite)

The smoke test found the strategy table empty, so the surface has never been seen with real
content.

**Set up by seed, then spot-check** (decided 16 Sep 2026). Run this once in the staging Render
Shell:

```
npm run seed:portal-acceptance
```

The seed writes every row **through the same commands the staff console calls** — so the rows
carry their audit event, outbox entry, version and provenance, and the entry path is still
exercised. It is re-runnable: creations replay, and the target dates are refreshed back into their
due-state buckets, so a run weeks later does not quietly turn "due soon" into "overdue" and
invalidate criteria 13–16.

It prints a summary mapping each seeded case to the criterion below that it serves. **Spot-check
that summary against the staff console before viewing the portal** — the seed is only trustworthy
if what it claims to have made is what is actually on the plan.

Defaults to Bushy Tails; `SEED_CLIENT_NAME=…` picks another. `--withdraw-all` takes the seeded
strategies back off the plan afterwards, by deactivation, never deletion.

The table below is what the seed produces. Tick it as verified, not as requested.

| # | Item | Why it is in the list | Done |
|---|------|----------------------|------|
| 1 | **≥ 3 reduction strategies across ≥ 2 levers**, all `include_in_report = true`, varied status + progress | Grouping by lever cannot be checked with one lever, and a single row hides ordering | ☐ |
| 2 | One strategy with a **target date in the past** | Produces the `overdue` due state | ☐ |
| 3 | One with a target date **inside 30 days** | Produces `approaching` — 30 is `strategyReminderWindowDays`, not a guess | ☐ |
| 4 | One with a target date **beyond 30 days** | Produces `scheduled`, so all three live states appear together | ☐ |
| 5 | One with **no target date at all** | The honest "no date" case — the surface must show no date rather than invent one | ☐ |
| 6 | At least one **bespoke** strategy (no library description) | Description is library-only; bespoke must show none | ☐ |
| 7 | At least one carrying a **reduction estimate** | So the estimate linkage is visible if the surface surfaces it | ☐ |
| 8 | At least one strategy **`include_in_report = false`** | The exclusion test has nothing to prove without one | ☐ |
| 9 | A **withdrawn / deactivated** strategy aligned to an SRS gap | Proves the reverse link excludes it — checked on the readiness record, set up here | ☐ |
| 10 | Both flags present in the staging build: `portal-plan`, `portal-readiness` | They are gated now; absent, the surface is legitimately hidden and nothing below is testable | ☐ |
| 11 | Open the portal **as that client** (portal auth, not staff) | Everything below is about what a client sees | ☐ |

**Note on flags:** `NEXT_PUBLIC_*` is inlined at `next build`, so the value that matters is the one
set in the Render dashboard **at build time** — a dashboard edit needs a rebuild to take effect
(`docs/DEPLOYMENT.md` §"Feature-flag flips"). Record the value you actually built with in the run
header.

---

## Part 2 — criteria

### Content and grouping

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Shows only `include_in_report = true` strategies, **grouped by lever** | ☐ | |
| 2 | A strategy whose lever has been withdrawn falls under **"Other"** rather than disappearing or erroring | ☐ | |
| 3 | The excluded (`include_in_report = false`) strategy is **absent** — not greyed, not collapsed, absent | ☐ | |

### Per strategy

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 4 | Title shown | ☐ | |
| 5 | Description shown **for library strategies only**; a bespoke strategy shows **no** description rather than an empty block or a placeholder | ☐ | |
| 6 | **Control-level chip** present and correct (`controlLevelLabel`) | ☐ | |
| 7 | Scope shown | ☐ | |
| 8 | Status shown | ☐ | |
| 9 | Progress shown | ☐ | |
| 10 | Target date shown, **dd/mm/yyyy** | ☐ | |
| 11 | **SRS alignment** shown where the strategy addresses a requirement | ☐ | |
| 12 | **Owner is not shown anywhere** — it is an internal handle and must not reach a client | ☐ | |

### Due state — must match the #164 signals exactly

The portal must not invent a second opinion about lateness. The four states come from
`strategyDeadline()` in `packages/contracts/src/reductionStrategies.ts`, with a 30-day window:

| # | Set-up strategy | Expected state | Shown correctly | Evidence |
|---|-----------------|----------------|-----------------|----------|
| 13 | Target date in the past | `overdue` (with days overdue) | ☐ | |
| 14 | Target date within 30 days | `approaching` | ☐ | |
| 15 | Target date beyond 30 days | `scheduled` | ☐ | |
| 16 | No target date | `none` — **no date, and no due signal invented** | ☐ | |
| 17 | A **completed** strategy with a past date | `none` — finished work does not go on being late | ☐ | |
| 18 | Any strategy, compared side by side with the staff console | The **same** signal in both | ☐ | |

### Live, not frozen

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 19 | Make a workspace edit (change a title, status or date), reload the portal, and **confirm it appears** | ☐ | before/after screenshots |
| 20 | The surface reads from the live model, **not** a `report_compositions` snapshot | ☐ | |

### Honest states

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 21 | A client with **no plan** gets an honest empty state — not a blank panel, not a zero | ☐ | |
| 22 | **No invented dates** anywhere | ☐ | |
| 23 | A **failed** read is distinguishable from an empty one — a failure must never render as "nothing planned" | ☐ | |

### Read-only

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 24 | No edit control is reachable — no buttons, and no form routes reachable by URL | ☐ | |

### The gate (NZC-080)

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 25 | With `portal-plan` **removed** from `NEXT_PUBLIC_FEATURE_PORTAL` and rebuilt, the surface is **hidden** | ☐ | |
| 26 | With the token **restored** and rebuilt, the surface **returns** unchanged | ☐ | |

**This is the criterion that costs a rebuild each way.** It is worth running properly rather than
reasoning about: the whole point of NZC-080 was that neither surface could be withdrawn without a
revert, and an untested gate is the same position with extra confidence.

### Cross-checks

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 27 | **Tenant isolation** — the client sees only their own org's plan (verify with a second client if one is available; if not, record that and why) | ☐ | |
| 28 | Renders in the **portal theme**, not the staff theme | ☐ | |
| 29 | Dates dd/mm/yyyy throughout | ☐ | |
| 30 | Reads coherently **beside the readiness statement** — "where I stand + what I'm doing" | ☐ | |

---

## Failures raised

| # | Criterion | What happened | Fix PR | Re-run |
|---|-----------|---------------|--------|--------|
| | | | | |

## Sign-off

- [ ] Every criterion above is ✅, or ❌ with a fix PR merged and that criterion re-run
- [ ] Screenshots attached or linked in the run header
- [ ] `CLIENT_WORKSPACE_BACKLOG.md` §M portal plan row flipped from "⚠️ still owes acceptance" to
      **accepted**, citing this document
- [ ] NZC-080 updated in `DECISIONS.md` once **both** this and
      `STAGING_ACCEPTANCE_PORTAL_READINESS.md` are complete — the decision covers both surfaces and
      is not closed by one

| | |
|---|---|
| Accepted by | |
| Date (dd/mm/yyyy) | |
