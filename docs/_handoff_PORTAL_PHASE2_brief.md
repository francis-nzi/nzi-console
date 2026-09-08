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

## PRECONDITION — security boundary (verified 08 Sep 2026 against the code)

**Two of the three items are already done and solid — do NOT rebuild them. Only the terms gate is a real
gap.** Cowork traced the rebuild's portal auth path directly; findings below.

### P1. Inactivity auto-logout — ✅ DONE (present, server-authoritative). No work.
`PortalInactivityGuard` is wired into `apps/console/app/portal/layout.tsx`. The client half gives the warning
countdown + activity-slides-the-window UX and ends the session on timeout; the **authoritative** half is
server-side: `resolvePortalPrincipal` (`packages/isolated-backend/src/auth.ts`) only returns a session where
`last_seen_at > now() - (idleLimit)::interval` (plus `revoked_at IS NULL`, `expires_at > now()`,
`u.status='active'`), so a closed-laptop session self-heals within the window regardless of the client. Idle
limit is configurable via `NZI_PORTAL_IDLE_LIMIT_MINUTES` (default 30). This is stronger than the live
implementation, not weaker.

### P2a. MFA enforcement — ✅ DONE (structurally enforced). No work.
The login route (`api/portal/auth/login/route.ts`) sets **no session cookie** — it always returns
`mfaRequired:true` + a challenge token. Only `api/portal/auth/mfa/route.ts` → `completePortalMfa` issues the
session, and only after a valid TOTP (attempt-limited to 5, challenge-expiry checked, secret decrypted from
`portal_credentials`). There is no code path that mints a portal session without passing MFA. Nothing to
enforce — it already can't be bypassed.

### P2b. Accept-terms gate — ⚠️ REAL GAP. Build this. (The only precondition item with work.)
Live gates the portal behind terms acceptance via a `must_accept_tac` flag: `login/page.tsx` routes to
`/accept-terms`, and `PortalShell.tsx` re-checks it on **every** shell load (`if (d.must_accept_tac)
router.replace("/accept-terms")`). The rebuild has **no terms handling anywhere** — no `must_accept_tac`, no
`/accept-terms` route, nothing in `completePortalInvitationSetup`. Build it to match live:
- A `must_accept_tac` (or equiv) flag on the portal user / returned by `/api/portal/auth/me`.
- A terms-acceptance step gating first authenticated access, recording who accepted which version and when.
- Re-checked on shell load, not only at first login (so a re-issued terms version re-gates existing users).
- e2e: a portal user with terms outstanding is blocked from portal data until acceptance is recorded.

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

### A2-lite. Spheres of Influence action tracker → live `PortalActions` / `ActionLeverGrid` / `LeverSelect`
**Direction confirmed 8 Sep 2026:** port the live 24-lever taxonomy and client actions with completion %, but build no projection model. Live has no lever-to-tCO₂e maths and NZI has no assured reduction methodology.
- Show the read-only assured baseline from `/dashboard` alongside the tracker as context.
- Store lever, action and completion as separate client-managed engagement data, never as emissions data.
- Label and structure completion percentages so they cannot be read as emissions reductions.
- No write-back into, or derivation from, reported figures.

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
- [x] P1 inactivity logout — verified present & server-authoritative (no work).
- [x] P2a MFA — verified structurally enforced (no work).
- [ ] P2b accept-terms gate built to match live (`must_accept_tac`), re-checked on shell load; e2e blocks a
      client with terms outstanding.
- [ ] A1 dashboard renders from `@nzi/charts`, canonical scope palette, text equivalents for every figure,
      empty-state handled.
- [ ] A2-lite preserves all 24 live levers and qualitative action completion; the assured baseline is read-only context and no projection or reported-figure mutation exists.
- [ ] All 2a/2b surfaces behind `portal-analytics` (or sibling), off in prod until acceptance is met; hard
      precondition, no silent e2e skips.

---

*Sequence: P2b (accept-terms) → A1/A2 → 2b. P1 and P2a are already done. Delete this hand-off once the items
are in the acceptance docs / register.*
