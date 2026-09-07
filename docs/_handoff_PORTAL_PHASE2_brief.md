# Client portal — Phase 2 (analytics & engagement) — brief for Claude Code

**Prepared 07 Sep 2026 (Cowork).** From Francis, following the client-portal parity map
(Artifact https://claude.ai/code/artifact/a77438fa-b130-4106-80d6-261fd075e656). The rebuild has the
**governed core** a client touches every engagement — enter data → review/approve → receive an assured
report — and in places (scope→category entry, bucket-grant governance) it's tighter than live. What's
missing is almost the whole **client-facing analytics & engagement layer** the live portal has. This brief
sequences that layer, and pulls the two security items forward as a **hard precondition** rather than a
feature.

New portal: `apps/console/app/portal`. Live reference: `NZI Live/portal/src/components`. Same discipline as
every prior track — branches + PRs, behind flags, e2e with the **hard-precondition-once-live** rule
(fail-loud, no silent skips).

---

## 0. The governance rule that constrains every surface below (read first)

**Everything a client sees in the analytics layer must be sourced from the content-addressed *reviewed /
published snapshot* — never from draft or in-progress rows.** A client dashboard that reflects unreviewed
numbers would show figures that haven't been through the governed review, which breaks the assurance promise
the whole spine exists to make.

- Every analytics surface reads its figures from the latest **published** report version (or an explicitly
  "provisional" state clearly labelled as such), resolved through the **same figure resolver** the report and
  Data Assurance use, so the portal number, the report number and the CRM number are always the same value.
- No portal analytics surface may read the editable row store directly. If a figure isn't in a published
  snapshot yet, the surface says "not yet published", not a live draft number.
- This is the acceptance gate for the whole phase: **an e2e that publishes a version, changes a draft row,
  and asserts the portal figure did NOT move** (it still reflects the published snapshot). Add it before the
  first surface ships.

---

## PRECONDITION — security boundary (do this first, gate the rest on it)

These two aren't features to schedule alongside dashboards — they're the boundary that has to be closed
before real client users are let in. Land them first, on their own PRs.

### P1. Inactivity auto-logout
Live has `PortalInactivityLogout`; no equivalent found in the rebuild portal. Add idle-session auto-logout to
the portal shell — configurable timeout, a warning countdown before it fires, activity resets the timer, and
it ends the session server-side (not just a client redirect). e2e: idle past timeout → session invalid on
next request.

### P2. MFA enforcement + accept-terms — **verify, then close the gap**
The rebuild has the auth *pages* (login, invite setup, recover, account); what's unverified is
**enforcement**. Before building anything else:
- Confirm the client login path actually **enrols/enforces MFA** for client users (live has a dedicated
  `setup-mfa` step). If enforcement is missing, add it — a client without MFA cannot reach portal data.
- Confirm first login is **gated behind terms acceptance** (live `accept-terms`). If missing, add the gate to
  the invite/first-login flow.
- e2e for each: client without MFA enrolled is blocked from data; first login without accepted terms is
  blocked from the portal.

Report back what you found on enforcement before assuming these need building — they may be partly there.

---

## Phase 2a — the two most client-visible surfaces

Ship these two first; they're what a client opens the portal *for* between reporting cycles.

### A1. Client dashboard + charts  →  live `PortalDashboardCharts` / `GaugeChart`
The client's headline emissions view and the portal's landing analytics.
- **Totals + scope split + trend + gauge**, all from the published snapshot (§0). Reuse the **print-safe SVG
  charts in `@nzi/charts`** (the R1 work) rather than a new chart lib, so portal and report render the same
  marks. Scope colours are the canonical palette (S1 coral #FF5C48, S2 amber, S3 emerald #0BA75E).
- Trend is the multi-year series already computed for Data Assurance (5-year), exposed read-only to the
  client for their own entity/engagement.
- Empty/first-engagement state: no published version yet → a clear "your first assured report will appear
  here" state, not a zeroed dashboard.
- a11y: charts need text/table equivalents (Francis runs Narrator) — every figure on the dashboard must be
  reachable as text, not pixels only. Reuse the tablist/dialog patterns already hardened on the CRM side.

### A2. Decarbonisation actions / levers  →  live `PortalActions` / `ActionLeverGrid` / `LeverSelect`
The reduction-planning tool — the biggest engagement feature and the reason clients come back.
- Client selects **levers** against their footprint and sees modelled impact vs their assured baseline.
- **Baseline is the published snapshot** (§0). Lever modelling is a **presentation-time projection off the
  assured baseline** — it must never write back into, or be confused with, actual reported figures. Keep
  projected/what-if figures visually and structurally distinct from assured actuals (mirror the BL-pill /
  provisional treatment used in Data Assurance).
- Persist a client's selected scenario so it survives reload, but store it as a **scenario artefact**, not as
  edits to emissions data.
- Check the live `LeverSelect` / `ActionLeverGrid` for the lever catalogue and impact maths before
  re-deriving them — reuse the live logic the way we did for the LCA engine, don't reinvent it. Flag any
  place the live maths is unclear rather than guessing.

**Flag:** put 2a behind a single `portal-analytics` flag (build-time `NEXT_PUBLIC_*`, dashboard-authoritative
— remember it needs **Clear build cache & deploy** to take, like the others). Off in prod until the
precondition PRs are merged and the §0 e2e is green.

---

## Phase 2b — the rest of the layer (deferred, listed so nothing is lost)

Build after 2a proves the snapshot-sourcing pattern. Each reads from the published snapshot per §0, behind the
same or a sibling flag, each with e2e:

- **Insights** (`PortalInsights`) — narrative/AI insights surface for the client.
- **Risk** (`PortalRisk`) — climate/transition risk view.
- **SRS readiness** (`PortalSrsReadiness`) — UK SRS / disclosure-readiness tracker.
- **Geospatial site map** (`PortalGeoMap`) — sites on a map (the Phase 1.5 geospatial scope in the live docs).
- **Facility leaderboard** (`PortalFacilityLeaderboard`) — ranked site/facility comparison.
- **Portfolio roll-up dashboard** (`PortalPortfolioDashboard`) — multi-entity roll-up metrics. Distinct from
  the engagement *list* the rebuild already has; this is the cross-entity dashboard.
- **Files / document store** (`PortalFiles`) — client-facing document library (evidence, deliverables,
  shared files).
- **Category history table** (`PortalCategoryHistoryTable`) — portal-side per-category YoY history for the
  client (the CRM-side 5-year trend, exposed to clients).

---

## Acceptance checklist (whole phase)

- [ ] §0 snapshot-sourcing e2e green **before** any 2a surface ships (publish → change draft → portal figure
      unchanged).
- [ ] P1 inactivity logout: idle past timeout invalidates the session server-side; e2e proves it.
- [ ] P2 MFA + accept-terms **enforcement** confirmed or added; e2e blocks a non-MFA / non-terms client.
- [ ] A1 dashboard renders from `@nzi/charts`, canonical scope palette, text equivalents for every figure,
      empty-state handled.
- [ ] A2 levers model off the assured baseline as a projection; what-if figures never mutate reported data
      and are visually distinct.
- [ ] All 2a/2b surfaces behind `portal-analytics` (or sibling), off in prod until acceptance is met; hard
      precondition, no silent e2e skips.

---

*Sequence: P1/P2 → A1/A2 → 2b. Delete this hand-off once the items are in the acceptance docs / register.*
