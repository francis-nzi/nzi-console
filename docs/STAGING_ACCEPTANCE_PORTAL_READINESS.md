# Portal SRS readiness (#177) — acceptance record

Running record against `docs/_handoff_PORTAL_ACCEPTANCE_PLAN.md` and the surface's own brief,
`docs/_handoff_PORTAL_SRS_STATEMENT_brief.md`. Closes half of **NZC-080**.

**This surface is already live on staging.** Like the plan, it shipped without the formal
acceptance pass and was given a rollout gate retrospectively. A gate is not an acceptance — it is
only the ability to withdraw. This record is what makes the surface *accepted*.

This one carries the higher disclosure risk of the two. The plan shows a client work they already
know about; readiness shows them **an assessment of themselves**, drawn from a framework staff fill
in — which means a draft assessment, an internal note, or another tenant's row reaching this
surface is a disclosure, not a display bug. The criteria below are weighted accordingly.

> **Template — nothing below is ticked.** `☐` = not yet checked · `✅` = passed · `❌` = failed
> (raise a fix PR, then re-run that one criterion) · `n/a` = not reachable this run, with the
> reason written in.

> **Running this through the staff portal preview (NZC-087).** The portal enrolment and login flow
> is erroring and is parked for revamp (NZC-088), so the walk-through uses
> **`/clients/{id}/portal-preview`** — read-only, under your own staff identity, rendering the
> client's own components through the client's own read models.
>
> That makes the **content**, **gate** and **single-tenant** criteria acceptable: they are
> properties of what the surface renders, and the preview renders it from the same resolvers.
>
> It does **not** make the **portal-auth criteria** acceptable. Anything that tests the login path
> itself — cross-tenant isolation reached *via a portal session*, the MFA flow, session-ended
> behaviour — is **`deferred`**, not `✅`. Mark those rows `deferred (NZC-088)` and leave them
> open. A criterion the preview structurally cannot exercise is not a criterion the preview has
> passed, and ticking it would be the most expensive kind of wrong: a governance record asserting
> an isolation property nobody checked.

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

Shares the client and strategy set-up in `STAGING_ACCEPTANCE_PORTAL_PLAN.md` Part 1 — do that
first — the same `npm run seed:portal-acceptance` produces both halves in one run, including the
completed assessment and the four reverse-link cases below.

The seed goes through `srs.assessment.start` / `.item.set` / `.complete`, the same commands the
assessor uses, so the assessment is a real one rather than rows shaped to look like one. It leaves
an existing completed assessment alone rather than starting a second: one completed assessment is
the state these criteria are written against.

**Spot-check the seed's printed summary against the staff SRS dashboard before viewing the
portal.** Criteria 6–8 all assert that a gap reads as *unaddressed*, and that is exactly what a
seed which silently failed to create the strategy would also produce — so the evidence for those
three has to start with confirming the strategy exists and is aligned.

| # | Item | Why it is in the list | Done |
|---|------|----------------------|------|
| 1 | Plan-side set-up complete (`STAGING_ACCEPTANCE_PORTAL_PLAN.md` Part 1) | The reverse link has nothing to point at otherwise | ☐ |
| 2 | A **completed** SRS assessment — explicitly **not** a draft | The central disclosure test needs a completed one to compare against | ☐ |
| 3 | A mix of **met and gap** requirements **across pillars** | Per-pillar maturity and shortfall ordering are invisible with a uniform result | ☐ |
| 4 | At least one gap **addressed by a client strategy** (`include_in_report = true`, active) | The positive case for the reverse link | ☐ |
| 5 | At least one gap with **no strategy against it** | The honest-marker case — this is the one most likely to be quietly wrong | ☐ |
| 6 | At least one gap addressed **only** by a **withdrawn / deactivated** strategy | Proves withdrawn strategies are excluded — and that the gap then reads as unaddressed, not as covered | ☐ |
| 7 | At least one gap addressed **only** by an `include_in_report = false` strategy | Proves the portal filter applies to the reverse link too, not just the plan list | ☐ |
| 8 | An **internal assessment note** recorded on at least one requirement | You cannot prove notes do not leak without one that would leak | ☐ |
| 9 | A **second, draft** assessment in progress (or the ability to start one) | For the draft-not-shown and "in progress" criteria | ☐ |
| 10 | Both flags present in the staging build: `portal-plan`, `portal-readiness` | Gated now; absent, the surface is legitimately hidden | ☐ |
| 11 | Open the portal **as that client** (portal auth, not staff) | | ☐ |

**Note on flags:** `NEXT_PUBLIC_*` is inlined at `next build`, so the dashboard value **at build
time** is what ships. Record what you actually built with.

---

## Part 2 — criteria

### Maturity and gaps

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | **Overall maturity** shown | ☐ | |
| 2 | **Per-pillar maturity** shown | ☐ | |
| 3 | Gaps are **ordered by shortfall** — largest gap first, not alphabetical and not source order | ☐ | |
| 4 | The figures shown match what the staff SRS dashboard shows for the same assessment | ☐ | |

### The reverse link — gap → addressing strategies

This is the join that was built read-side, and each row below is a way it can be wrong while still
looking plausible.

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 5 | A gap addressed by an active, in-report strategy lists **that strategy** | ☐ | |
| 6 | A **withdrawn / deactivated** strategy is **excluded** — and its gap reads as unaddressed rather than silently covered | ☐ | |
| 7 | An `include_in_report = false` strategy is **excluded** from the reverse link | ☐ | |
| 8 | A gap with no qualifying strategy shows the honest **"no strategy aligned yet"** marker — not an empty list, not a blank cell | ☐ | |
| 9 | The strategies named here are the **same ones** the portal plan shows — the two surfaces do not disagree | ☐ | |

### Live, not frozen

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 10 | **Re-assess** a requirement in the staff console, reload the portal, and **confirm the score moves** | ☐ | before/after screenshots |
| 11 | Add a strategy against a previously unaddressed gap, reload, and confirm the reverse link picks it up | ☐ | |
| 12 | The surface reads the live model, **not** a frozen composition | ☐ | |

### Disclosure — the criteria that matter most

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 13 | A **draft** assessment is **not shown** — its figures must not appear anywhere on the surface | ☐ | |
| 14 | A client **mid-assessment** sees an honest **"in progress"**, not a stale completed score presented as current, and not an empty state implying no assessment exists | ☐ | |
| 15 | **No internal assessment notes** appear — check the rendered page **and the page source / network response**, since a field can be absent visually and present in the payload | ☐ | |
| 16 | No assessor identity, internal handle or staff-side commentary is exposed | ☐ | |
| 17 | **Tenant-scoped** — the client sees only their own org's assessment (verify with a second client if available; if not, record that and why) | ☐ | |

**On criterion 15:** checking the rendered page alone is not sufficient evidence. A note that is
fetched and then not displayed has still been disclosed to anyone who opens developer tools, and
this surface is the most likely place in the portal for that to happen.

### Read-only

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 18 | No edit control reachable — no buttons, and no assessment routes reachable by URL | ☐ | |

### The gate (NZC-080)

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 19 | With `portal-readiness` **removed** from `NEXT_PUBLIC_FEATURE_PORTAL` and rebuilt, the surface is **hidden** | ☐ | |
| 20 | With the token **restored** and rebuilt, the surface **returns** unchanged | ☐ | |
| 21 | Removing `portal-readiness` **does not** hide the plan — the two tokens are independent | ☐ | |

### Cross-checks

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 22 | Renders in the **portal theme** | ☐ | |
| 23 | Dates dd/mm/yyyy throughout | ☐ | |
| 24 | Reads coherently **beside the plan** — "where I stand + what I'm doing" | ☐ | |
| 25 | Language is client-appropriate: a gap reads as a gap, not as a failure, and "reviewed, not assured" is not overstated anywhere | ☐ | |

---

## Failures raised

| # | Criterion | What happened | Fix PR | Re-run |
|---|-----------|---------------|--------|--------|
| | | | | |

## Sign-off

- [ ] Every criterion above is ✅, or ❌ with a fix PR merged and that criterion re-run
- [ ] Screenshots attached or linked in the run header
- [ ] `CLIENT_WORKSPACE_BACKLOG.md` §M portal readiness row flipped from "⚠️ still owes acceptance"
      to **accepted**, citing this document
- [ ] NZC-080 updated in `DECISIONS.md` — do this once **both** this and
      `STAGING_ACCEPTANCE_PORTAL_PLAN.md` are complete; the decision covers both surfaces and is
      not closed by one

| | |
|---|---|
| Accepted by | |
| Date (dd/mm/yyyy) | |
