# M1 client portal staging acceptance record

**Environment:** isolated staging only  
**Service:** `nzi-console` (`srv-d6o8snvgi27c73frfta0`)  
**URL:** `https://nzi-pro-api-prod.onrender.com`  
**Accepted revision:** `628f427fd3a11baf67762dca0bd2e2afcac15276`  
**Recorded:** 27 August 2026

## Automated acceptance evidence

- `npm run test:portal`: 68 passed, 0 failed.
- `npm run typecheck`: passed across the workspaces.
- `npm run build`: production Next.js build completed, including all 28 static pages.
- `git diff --check`: passed.
- `origin/main` and the accepted local revision both resolved to `628f427fd3a11baf67762dca0bd2e2afcac15276` before deployment verification.
- The deployed `/api/health` endpoint returned `status=ok`, `env=staging`, `dataMode=isolated-api`, `writes=enabled`, `authentication=enabled`, and `authenticationRequired=true` at `2026-08-27T22:03:55.000Z`.

The executable portal suite covers identity, portfolio visibility, invitation and MFA enrolment, session lifecycle, recovery, job grants, immutable publications, report approval, review messaging, data-entry windows and submissions, deliverables, tenant isolation, origin protection, login throttling, and stale-session expiry.

## Known limitations and open evidence

- Rendered keyboard, focus-order, screen-reader and contrast inspection remains open. Source-level accessibility contracts pass, but they are not a substitute for assistive-technology review.
- Rendered phone, tablet, laptop and wide-desktop inspection remains open. Responsive source contracts pass, but viewport evidence has not yet been captured.
- Full browser journeys from invitation enrolment through publication approval and data submission remain open. Their service and contract layers are covered by automated integration tests.
- Production release is not authorised. This service and its database boundary remain explicitly non-production.

These limitations block completion of the P5 portal acceptance gate, but do not invalidate the automated staging evidence above.

## Rollback check

The immediately preceding green revision is `f62a44b` (`Establish portal responsive foundation`). Git ancestry verification confirms it is an ancestor of the accepted revision, so it remains an available application rollback target.

Rollback procedure:

1. Revert `628f427` on `main` with a new auditable commit and push it to trigger Render auto-deploy.
2. Verify `/api/health` reports the expected staging isolation and authentication state.
3. Run `npm run test:portal`, `npm run typecheck`, and `npm run build` against the resulting revision.

For database containment independent of application rollback, set `NZI_DATA_MODE=fixture` on the Render service and deploy. This disconnects the application from the isolated database without deleting data. No rollback was executed during acceptance because the deployed revision was healthy.

## Rendered acceptance harness (30 August 2026)

A Playwright suite (`apps/console/tests/e2e/`) now renders the portal against **deployed
isolated staging** and is the standing rendered-acceptance gate. See
`docs/RENDERED_ACCEPTANCE_CHECKLIST.md` for how to run it.

- `portal.spec.ts` — real portal sign-in (password + TOTP) → portfolio → a granted job's
  published-report workspace (or an explicit state) → account security.
- `accessibility.spec.ts` — axe-core WCAG 2.1 A/AA on the portal sign-in and (authenticated)
  portal screens; fails on any serious/critical not in `axe-baseline.json`.
- `responsive.spec.ts` — full-page captures + no-horizontal-overflow at 390/768/1280/1920.

**Public smoke run recorded 30 Aug 2026** (against `8d1ec64`, no credentials): 7 passed,
31 auth-gated specs skipped, 0 failed. Two markup a11y defects found and fixed in the same
change (`.nz-auth-progress` `aria-label` on a bare `<div>`; `CommandSearch` input missing
`role="combobox"`); contrast findings catalogued in `axe-baseline.json` for a NZC-003
design-token pass.

**Still open:** the full authenticated run (needs `npm run acceptance:provision` against
isolated staging) and the manual assistive-technology narration pass (checklist §2).

### Authenticated run recorded 30 August 2026

`npm run acceptance:provision` + `npm run test:e2e` against `nzi-pro-api-prod.onrender.com`
(commit `385f6a5`): **39 / 39 passed**, 0 skipped. Portal login (real password + TOTP),
portfolio, account security, and the granted-job report workspace all render with the five
explicit states. Findings: the portal-home time-of-day greeting rendered server-side and
mismatched on hydration (React #418) — **fixed** (`PortalHome.tsx`, greeting now set
post-mount). `axe-baseline.json` carries the outstanding contrast items for the NZC-003
pass. Manual assistive-technology narration pass (checklist §2) still open.
