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
| **P2** — MFA enforcement | ✅ **already enforced** — see findings; nothing to build |
| **P2** — accept-terms gate | 🔴 missing — next PR |
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

### P2 — accept-terms — MISSING (next PR)

Live has an `accept-terms` step; the rebuild invite flow is password → MFA → active, with no terms gate and
no `terms_accepted_at` anywhere. To build: a `portal_users.terms_accepted_at` + `terms_version` (small
migration), acceptance captured at invite completion (and re-prompted if the version bumps), and the
request-time resolve / portal shell blocking data access until terms are accepted. e2e: a first-login
client without accepted terms is blocked from the portal.

---

## Phase 2a / 2b

Behind a single build-time `NEXT_PUBLIC_*` `portal-analytics` flag (dashboard-authoritative, needs **Clear
build cache & deploy**), off in prod until P1/P2 are merged and the §0 e2e is green. A1 (dashboard + charts,
`@nzi/charts`, canonical scope palette, text equivalents, real empty-state) and A2 (levers as a
presentation-time projection off the assured baseline, what-if visually distinct, scenario stored as an
artefact not as data edits) first; 2b after 2a proves the snapshot-sourcing pattern. Same
flag / e2e / hard-precondition discipline throughout.
