# Portal A2-lite — Spheres of Influence action tracker · acceptance

**Direction (8 Sep 2026):** preserve the live 24-lever action tracker, with no projection model. NZI has no assured lever-to-tCO₂e methodology, so the product must not put invented reductions beside assured figures.

**Flag:** `portal-actions` in `NEXT_PUBLIC_FEATURE_PORTAL`, dependent on `portal-analytics`.

## Boundary

- The assured baseline remains the read-only headline on the dashboard and comes exclusively from `GET /api/portal/jobs/{jobId}/dashboard`, which resolves the latest published snapshot.
- The tracker is a separate engagement store (`portal_tracker_actions`) containing only lever, action text, notes and completion percentage. It has no emissions quantity, factor, reduction or projection columns and never reads or writes canonical emissions rows.
- The UI labels the tracker “Client-managed engagement plan” and “Engagement data · not assured emissions”. Every percentage is described as action completion.
- The 3 spheres, 9 sub-spheres and 24 lever labels are ported from live unchanged.

## Gate

1. Published baseline remains visible above the tracker and unchanged after tracker writes.
2. All 24 levers render in live order, grouped as 3 spheres and 9 sub-spheres.
3. A client can add an action and edit its lever, title, notes and whole-number completion from 0–100%; reload preserves it.
4. Cross-client/job access is denied through the active portal grant and tenant RLS boundary.
5. Mutation routes require the portal origin and accepted-terms session; the acceptance spec removes its temporary action after the persistence proof.
6. No action or schema field represents tCO₂e, a factor, projected impact or reduction.
7. Keyboard: native disclosure controls, labelled fields/ranges, visible focus, and save outcome live region.
8. Screen reader announces sphere/lever hierarchy, action title/notes and completion value; colour is not the only progress signal.
9. Reduced motion and 390/768/1280/1920 layouts pass with no horizontal overflow.

Automated gate: `apps/console/tests/e2e/portal-actions.spec.ts` is a hard live precondition (no flag skip).
It creates, edits, reloads and removes a temporary action,
asserts the baseline total and data hash did not move, probes an ungranted job, runs axe and checks all four widths.

## Staging result — 8 September 2026

- `portal-analytics,portal-actions` confirmed in the dashboard-authoritative Render variable; migration
  `0059` applied to the isolated staging database.
- Render revision `ef898b0` live and `/api/health` green.
- Playwright: **4/4 passed** (setup plus both A2 journeys) against
  `https://nzi-pro-api-prod.onrender.com` — create/edit/reload/delete cleanup, assured total + data-hash
  invariance, wrong-job denial, axe, and 390/768/1280/1920 widths.
- Staging acceptance found and closed the audit JSONB binding failure and the inherited 720px mobile-table
  overflow in PRs #122/#123.
- **Human gate still open:** Narrator reading order/announcements and the OS reduced-motion sensory pass.

## Deployment

Apply additive migration `0059_portal_action_tracker.sql` to isolated staging, append `portal-actions` to the dashboard-authoritative `NEXT_PUBLIC_FEATURE_PORTAL`, then **Clear build cache & deploy**. Roll back the surface by removing only `portal-actions`; stored engagement actions remain inert and do not affect assured reporting.
