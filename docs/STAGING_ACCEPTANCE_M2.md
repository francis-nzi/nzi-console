# M2 core CRP workflow staging acceptance record

**Environment:** isolated staging only  
**Service:** `nzi-console` (`srv-d6o8snvgi27c73frfta0`)  
**URL:** `https://nzi-pro-api-prod.onrender.com`  
**Accepted implementation revision:** `d49eb7d02a342759741c6ad0efcf3ce0573e7f7c`  
**Recorded:** 28 August 2026

## Acceptance evidence

- `npm run test:portal`: 77 passed, 0 failed, including the complete canonical CRP command lifecycle.
- `npm run typecheck`: passed across all workspaces.
- `npm run build`: the production Next.js build passed and generated all 29 application pages.
- `git diff --check`: passed.
- Local `HEAD` and `origin/main` both resolved to `d49eb7d02a342759741c6ad0efcf3ce0573e7f7c` before this record was created.
- The deployed `/api/health` endpoint returned `status=ok`, `env=staging`, `dataMode=isolated-api`, `writes=enabled`, `authentication=enabled`, and `authenticationRequired=true` at `2026-08-28T08:33:55.631Z`.

The executable lifecycle creates a tenant-bound CRP job, establishes its reporting configuration, creates Scope 1, 2 and 3.1 evidence, resolves selected factors, calculates emissions with provenance and lineage, rejects stale row versions, records independent approval, rejects a stale job version at evidence freeze, creates a content-addressed reviewed snapshot, validates every required CRP chart, creates an immutable report version, and publishes that exact version with audit and transactional-outbox evidence.

Separate negative journeys block incomplete QA, mismatched snapshot evidence, and repeat publication.

## Implemented staff surface

The live CRP job workspace exposes canonical scope-row editing, dataset selection, factor calculation, lineage, quality evidence, independent review, targets, intensity, reviewed snapshot creation, manifest validation, and exact-version publication. The publication register reads immutable report versions and client-review status from the isolated boundary.

## Known limitations

- The complete staff journey has been executed through the real command services with a deterministic transactional test database adapter; it has not yet been observed interactively against the deployed staging database because no controllable browser session is connected.
- Rendered focus order, responsive behaviour, and end-user failure messaging for the CRP release controls remain part of the combined browser acceptance pass.
- This record authorises no production release. The service and database remain explicitly non-production.

These limitations preserve a clear distinction between implemented, automated acceptance and browser-observed staging acceptance.

## Rollback check

Revision `18924ad` (`Prove governed CRP release lifecycle`) is verified as an ancestor of the accepted implementation revision and remains the immediately preceding green rollback target.

Rollback procedure:

1. Revert `d49eb7d` on `main` with a new auditable commit and push it to trigger Render auto-deploy.
2. Verify `/api/health` continues to report staging isolation and required authentication.
3. Run `npm run test:portal`, `npm run typecheck`, and `npm run build` against the resulting revision.

For immediate database containment, set `NZI_DATA_MODE=fixture` and deploy. This disconnects the application from the isolated database without deleting data. No rollback was executed because the accepted implementation remained healthy.

## Rendered acceptance harness (30 August 2026)

`apps/console/tests/e2e/crp-workspace.spec.ts` renders the CRP job workspace end to end
against **deployed isolated staging** — command centre, stage sections, the per-entity
emission-source register, and the client-factor panel — asserting no failed/degraded state
and no console errors, plus a direct guard that `/api/isolated/jobs/{id}/factors` returns
200 (the numeric/text UNION regression fixed in PR #2). axe + viewport coverage for the
workspace is in `accessibility.spec.ts` / `responsive.spec.ts`. Run per
`docs/RENDERED_ACCEPTANCE_CHECKLIST.md` (`npm run acceptance:provision` then
`npm run test:e2e`).

**Still open:** executing the run with a provisioned staff account, and the rendered
configure→publish write journey.

### Authenticated run recorded 30 August 2026

Full Playwright suite against `nzi-pro-api-prod.onrender.com` (`385f6a5`): **39 / 39
passed**. The CRP job workspace renders end to end (command centre, per-entity register,
client-factor panel) and `/api/isolated/jobs/{id}/factors` returns 200. Findings fixed in
the same change: a `<select>` with no accessible name in the manual-dataset-exception
panel (`select-name`, critical) → `aria-label` added; the evidence drawer body was not
keyboard-scrollable (`scrollable-region-focusable`) → `tabIndex`. Known/open: a pre-existing
SSR/CSR hydration text mismatch (React #418) on the CRP workspace — catalogued in
`tests/e2e/lib/screen.ts`, to be located and fixed.
