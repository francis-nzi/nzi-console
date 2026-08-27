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
