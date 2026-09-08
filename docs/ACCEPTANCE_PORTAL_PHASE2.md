# Client portal — Phase 2 (analytics & engagement) — acceptance

Origin: Francis's brief (hand-off `docs/_handoff_PORTAL_PHASE2_brief.md`, 07 Sep 2026), following the
client-portal parity map. The rebuild has the governed core (enter → review → assured report); this phase
adds the client-facing analytics & engagement layer, with the two security items pulled forward as a **hard
precondition**.

New portal: `apps/console/app/portal`. Live reference: `NZI Live/portal/src/components`.

Sequence: **P1 / P2 → §0 e2e → A1 / A2 → 2b.**

| Item | Status |
|---|---|
| **P1** — inactivity auto-logout | 🟢 built (PR #114) |
| **P2a** — MFA enforcement | ✅ **already enforced** — see findings; nothing to build |
| **P2b** — accept-terms gate | 🟢 built (PR #115) |
| **§0** — snapshot-sourcing e2e | ⚪ before any 2a surface |
| **A1** — client dashboard + charts | ⚪ 2a |
| **A2** — decarbonisation levers | ⚪ 2a |
| **2b** — insights / risk / SRS / geo / leaderboard / portfolio / files / category history | ⚪ deferred |

---

## §0 — the governance rule (acceptance gate for the whole phase)

**Every client-facing figure reads from the content-addressed published snapshot** through the same path the
report and Data Assurance use — never from `job_scope_rows`.

- The resolver: `getCurrentPublishedCrpReport(db, jobId)` (`packages/isolated-backend/src/readModels.ts`) —
  joins `report_versions` (status `published`) to `reviewed_crp_snapshots`, **verifies
  `report.data_hash === snapshot.data_hash`** (throws otherwise), and returns
  `snapshot.payload_json.measurements` as the figure source. The portal published-report route already uses
  the granted variant (`getGrantedPublishedCrpReport`).
- No portal analytics surface may query the editable row store. If a figure isn't in a published snapshot,
  the surface says "not yet published", not a draft number.
- **e2e (before the first 2a surface):** publish a version → change a draft row → assert the portal figure
  did not move.

---

## PRECONDITION findings (P1 / P2)

### P1 — inactivity auto-logout — was MISSING, now built

The rebuild portal had no idle timeout: an 8-hour session token in an `HttpOnly` cookie, `portal_sessions`
with `last_seen_at` set at creation and never updated, no client guard. Live has `PortalInactivityLogout`
(1h) plus server self-heal on `last_activity_at` staleness.

**Built (PR #114):**
- **Server (authoritative)** — `resolvePortalPrincipal` (`packages/isolated-backend/src/auth.ts`), the single
  request-time resolve every portal API route goes through:
  - the SELECT now also requires `s.last_seen_at > now() - (idleLimit || ' minutes')::interval` — a stale
    session is rejected with `AuthenticationError` (so a closed laptop / killed client JS self-heals);
  - a throttled `UPDATE portal_sessions SET last_seen_at = now()` (one write / 30s) slides the window on
    activity;
  - the resolve runs in a `write` auth transaction now (was `read`).
  - idle limit from `NZI_PORTAL_IDLE_LIMIT_MINUTES` (default **30**); the resolved principal and
    `/api/portal/auth/me` carry `idleLimitMinutes` so the client matches without its own env.
  - no schema change — reuses `portal_sessions.last_seen_at` (migration 0018).
- **Client (UX)** — `apps/console/app/portal/PortalInactivityGuard.tsx`, mounted in `portal/layout.tsx` so
  it covers every portal route. Arms only after a successful `/me` (inert on `/portal/login`, no redirect
  loop). Activity resets a local timer + throttled `/me` pings (slide the server window). A 2-minute
  countdown **`role="alertdialog"`** ("Still there?") built on the hardened `@nzi/ui` `Drawer`
  (dialog + focus trap + Esc). "Stay signed in" pings `/me` and dismisses; timeout → `POST
  /api/portal/auth/logout` (genuine server-side revoke) → `/portal/login?reason=idle`.

**Gate (P1)**

| # | Check | Where |
|---|---|---|
| 1 | The resolve SELECT enforces the idle window and passes the configured limit; activity bump is throttled to 30s; a session the window excludes is rejected and not bumped; default 30 min | `portalSessionIdle.test.ts` (3) |
| 2 | A warning dialog appears before the cut with a live countdown; "Stay signed in" keeps the session | `portal-security.spec.ts` #1 (Playwright clock) |
| 3 | Idle past the limit → redirect to `/portal/login?reason=idle` **and** the next `/me` request is 401 (revoked server-side, not just redirected) | `portal-security.spec.ts` #2 (throwaway session) |
| 4 | `npm run typecheck` (all workspaces) · `@nzi/console` build · unit suites green | ✅ |
| 5 | Hard precondition once the portal is live — the only e2e skip is "no portal account on the target" | `portal-security.spec.ts` |

### P2 — MFA enforcement — ALREADY ENFORCED (verified, nothing to build)

Traced the full portal auth path:

- **Enrolment is gated.** `startPortalInvitationSetup` creates `portal_credentials` with `enabled = false`
  and a generated TOTP secret. `completePortalInvitationSetup` requires `verifyTotp(code, secret)` to pass
  before it sets `portal_credentials.enabled = true` and `portal_users.status = 'active'`. A portal user
  cannot become active without completing TOTP enrolment.
- **Login is gated.** `startPortalLogin` verifies email + password and issues only a short-lived
  `portal_login_challenge` — **no session, no cookie**. The *only* code that mints a portal session
  (`signPortalSession` + `portalSessionCookie`) is `/api/portal/auth/mfa` → `completePortalMfa`, which
  requires a valid TOTP against the enrolled secret and checks `row.enabled`.
- There is exactly one session-issuing path and it is TOTP-verified. **No gap.**

### P2b — accept-terms — was MISSING, now built (PR #115)

Live gates every shell load on `must_accept_tac` (`login/page.tsx`, `PortalShell.tsx` → `/accept-terms`);
the rebuild had no terms handling at all.

**Built (PR #115):**
- **Migration `0058_portal_terms_acceptances.sql`** — an **append-only** record: one row per
  `(organisation_id, portal_user_id, terms_version)`, `accepted_at`. RLS `tenant_isolation` +
  `auth_terms_acceptance` (the gate check and the write both run under the auth role at request time).
  `REVOKE UPDATE, DELETE` from every app role — an acceptance is permanent.
- **`resolvePortalPrincipal`** — when `NZI_PORTAL_TERMS_VERSION` is set (default **`2026-v1`**), the
  session still resolves but the principal carries `termsVersion` + `mustAcceptTerms` (true until an
  acceptance row for *that* version exists — so bumping the version re-gates every existing user). No
  version configured → never flagged (backwards compatible).
- **`packages/isolated-backend/src/portalTerms.ts`** (new) — `portalTermsVersion()` (env → default),
  `acceptPortalTerms(pool, session, {version}, currentVersion)` (idempotent `INSERT … ON CONFLICT DO
  NOTHING`; rejects a stale / empty / wrong version *before* any DB call; requires an active session),
  `PortalTermsRequiredError` + `requirePortalTermsAccepted(principal)`.
- **`lib/portalSession.ts`** — `currentPortalUserForData(request)` = `currentPortalUser` +
  `requirePortalTermsAccepted`. **All 10 portal `jobs/*` data routes** swapped to it; `/me`, `/password`
  and the new `/accept-terms` keep the plain `currentPortalUser` so an un-accepted user can still reach
  them. `authResponse` maps `PortalTermsRequiredError` → **403 `PORTAL_TERMS_REQUIRED`** (session cookie
  untouched — the session is valid, it just owes terms).
- **`/api/portal/auth/me`** returns `mustAcceptTerms` + `termsVersion`. **`/api/portal/auth/accept-terms`**
  (POST) records the acceptance.
- **`apps/console/app/portal/PortalTermsGate.tsx`** (new) — a blocking overlay on the hardened `@nzi/ui`
  `Drawer` (`onClose` no-op — not dismissible), mounted in `portal/layout.tsx` alongside the P1 guard.
  Re-checks `/me` on mount **and on tab refocus** (matches live's "every shell load"). The terms copy is
  `portalTermsContent.ts`, versioned with the env string. "Accept & continue" → `POST /accept-terms` →
  reload; "Decline & sign out" → `POST /logout` → `/portal/login?reason=terms-declined`. Inert when there
  is no session.
- **`auth.setup.ts`** does NOT accept terms; **`provision-acceptance-accounts.ts`** deletes any
  acceptance for the fixed portal user each run — so `portal-security.spec.ts` (which runs first) can
  exercise the block, then records acceptance, clearing it for every later portal test.

**Gate (P2b)**

| # | Check | Where |
|---|---|---|
| 1 | Version helper defaults + trims; `mustAcceptTerms` flagged only when a version is configured and no acceptance row exists; not flagged when the row is present or no version is set | `portalTerms.test.ts` |
| 2 | `acceptPortalTerms` — idempotent insert for the current version; rejects stale/empty/wrong version with no DB call; rejects an inactive session | `portalTerms.test.ts` |
| 3 | `requirePortalTermsAccepted` throws `PortalTermsRequiredError` (carrying the version) when outstanding | `portalTerms.test.ts` |
| 4 | A user with terms outstanding: `/api/portal/jobs` → **403 `PORTAL_TERMS_REQUIRED`**; the overlay renders; after accepting, the same route → 200 and `/me` clears the flag. Stale / empty version at the endpoint → 409 / 422 | `portal-security.spec.ts` — P2b |
| 5 | `npm run typecheck` (all workspaces) · `@nzi/console` build · unit suites green | ✅ |
| 6 | Migration diffed + applied to isolated staging before merge | ✅ (see verification) |
| 7 | Hard precondition once the portal is live — skips only on "no portal account" and (block leg only) "re-run without provision" | `portal-security.spec.ts` |

---

## Phase 2a / 2b

Behind a single build-time `NEXT_PUBLIC_*` `portal-analytics` flag (dashboard-authoritative, needs **Clear
build cache & deploy**), off in prod until P1/P2 are merged and the §0 e2e is green.

### Reconnaissance (08 Sep 2026) — before building 2a

- **Live's portal dashboard is NOT snapshot-sourced.** `api/portal_routes.py::portal_job_overview` calls
  `get_scope_totals(job_id)` / `get_emissions_by_category(job_id)` (live data), and there's a
  `portal_live_report_data` endpoint mirroring the CRM *live* report. Only `portal_snapshot_data` reads the
  frozen `job_report_versions.snapshot_json`. The rebuild's §0 rule means A1 must source **only** from the
  published snapshot — a deliberate improvement on live, not a port.
- **A1 chart data shapes (live `PortalDashboardCharts`, recharts):** `scopeData {name,value}[]`, `total`,
  `trendData {year,total,scope1,scope2,scope3}[]`, `topCategoryData {category,emissions,percentage}[]`.
  Rebuild renders these with **`@nzi/charts`** (SVG-first). Totals / scope / top-category from
  `getCurrentPublishedCrpReport().snapshot.measurements`; the 5-year trend from the Data Assurance chain
  (`resolveCrpReportingChain` already resolves the prior *published* snapshot per reporting year).
- **⚠️ A2 — the live `LeverSelect` / `ActionLeverGrid` / `PortalActions` contain NO emissions-projection
  maths.** They implement a qualitative **Spheres of Influence** framework (3 spheres → 9 sub-spheres →
  24 levers; Futerra / Oxford Net Zero) — `services/report_actions.py` computes per-lever
  `action_count` / `completed_count` / `AVG(progress)` over tracked *actions* (name, description,
  category, progress %, target date). There is **no lever → tCO₂e-abatement model** anywhere in live.
  The brief's A2 ("client selects levers … sees **modelled impact vs their assured baseline** …
  presentation-time projection … what-if figures") describes a capability live does not have. **Flagged
  to Francis — needs direction on A2 scope before building** (like-for-like action tracker vs. a new
  projection model that needs a lever→abatement methodology).

A1 first (dashboard + charts, `@nzi/charts`, canonical scope palette, text equivalents, real
empty-state); A2 after the A2-scope question is answered; 2b after 2a proves the snapshot-sourcing
pattern. Same flag / e2e / hard-precondition discipline throughout.
