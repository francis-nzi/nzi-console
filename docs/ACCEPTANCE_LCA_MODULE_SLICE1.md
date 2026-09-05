# LCA/PCF reference module — slice 1: the Model Register · acceptance

Track C (job-family modularization, NZC-024). Decisions **NZC-052/054/055** (already confirmed 1 Sep 2026;
this slice is implementation, not new decisions). Companion: `docs/MODEL_FIDELITY_JOB_FAMILIES.md` §2/§6/§7.
Flag: **`job-module-lca`** in a new variable **`NEXT_PUBLIC_FEATURE_JOB_MODULES`** (a third flag variable,
alongside `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` and `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` — a job-family module
is neither a data-entry adapter nor a report slice). `FamilyWorkspace` still serves `lca`/`pcf` jobs when
the flag is off, per the build order in `MODEL_FIDELITY_JOB_FAMILIES.md` §7.

## Scope of this slice

The **Model Register** only — list an LCA/PCF job's assessments and add/edit one's header fields (name,
type, functional unit, lifecycle boundary, included EN 15804 modules, standard, reference year, geography).
**Not in this slice** (each is its own later slice, per the doc's own build order — "assessment register →
line-item grid → transport legs → factor mapping → recalculate → module breakdown chart → report
manifest"): line items, factor mapping, transport legs (+ geocoding), the calc engine / result snapshots,
charts, the report manifest, and the assessment review/sign-off workflow (approve/reject). Every assessment
this slice creates is intentionally inert — `total_tco2e` stays 0, `lines`/`scenarios` are always `[]` — until
the line-item slice lands.

## What's built

- **`packages/contracts/src/jobFamilies.ts`** — already had the full `LcaAssessment`/`LcaLineItem`/
  `LcaTransportLeg`/`LcaScenario`/`LcaResultSnapshot` read-model types from Phase 0 (types only, no
  runtime). This slice adds `LcaAssessmentWriteFields` (the editable subset) and `lcaModuleCodes` (the
  canonical EN 15804 code list, for validation without a DB round-trip).
- **`packages/contracts/src/commands.ts`** — `lca.assessment.create` / `lca.assessment.update`, permission
  `emissions.data.edit` (reused, not invented), full field validation (name required, functional unit value
  > 0, lifecycle boundary/assessment type/module codes all checked against the real enums).
- **`packages/isolated-backend/src/lcaAssessments.ts`** (new) — `listLcaAssessments` / `createLcaAssessment`
  / `updateLcaAssessment`. `createLcaAssessment`/`updateLcaAssessment` reject a job whose family isn't
  `lca`/`pcf` (`WRONG_FAMILY`) — but LCA and PCF **share one model** (NZC-052), so a `pcf` job is accepted,
  not just `lca`. `updateLcaAssessment` is optimistically locked (`expectedVersion`, same convention as
  `scope.row.update`/`report.section.edit`). No migration — Phase 0's `0046_lca_assessments` already has
  everything this slice reads/writes.
- **API routes** — `GET/POST /api/isolated/jobs/{jobId}/lca-assessments`, `PATCH
  /api/isolated/jobs/{jobId}/lca-assessments/{assessmentId}` — same `requireCommandPrincipal` /
  `commandContext` / `commandSuccess`/`commandFailure` pattern as every other command route.
- **`apps/console/app/jobs/lca/LcaWorkspace.tsx`** (new) — reuses `AppShell`/`TopBar`/`WorkspaceRail`/
  `WorkflowStageControl` exactly as `FamilyWorkspace` does (no shell forked); a register table + an
  add-assessment form (module codes as toggle chips). Wired into `apps/console/app/jobs/[jobId]/page.tsx`:
  `family==="crp"` → `CrpScopeWorkspace` (unchanged); `family` in `("lca","pcf")` **and** `job-module-lca` on
  → `LcaWorkspace`; otherwise → `FamilyWorkspace` (unchanged, still the fallback for every other family and
  for lca/pcf with the flag off).
- **`apps/console/app/lib/jobModuleFlags.ts`** (new) — the third flag-variable file, same shape as
  `featureFlags.ts` / `reportFlags.ts`.
- Reuses the existing `"lca"` `ScreenKey`/`screenContracts` entry (`{key:"lca", validate: rows(…,
  "assessments")}`) — already present from Phase 0, anticipating exactly this shape.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `createLcaAssessment`/`updateLcaAssessment` accept `lca` **and** `pcf` jobs, reject any other family | `lcaAssessments.test.ts` |
| 2 | Validation rejects a blank name, an unrecognised module code, a non-positive functional unit value | `lcaAssessments.test.ts` |
| 3 | `updateLcaAssessment` is optimistically locked — a stale `expectedVersion` is a version conflict | `lcaAssessments.test.ts` |
| 4 | `listLcaAssessments` derives `isPcf` from `standard`/`lifecycleBoundary`; `lines`/`scenarios` are always `[]` (no command creates either yet — honest, not a shortcut) | `lcaAssessments.test.ts` |
| 5 | Flag OFF: `job.header.family==="lca"` renders `FamilyWorkspace` exactly as before | code review — single flag-gated branch in `page.tsx`, no other change |
| 6 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification (PR #94)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green.
- `packages/isolated-backend/tests/lcaAssessments.test.ts` — 8 new tests.
- No migration — `0045`–`0047` (Phase 0) already applied to isolated staging and verified present (this
  session, before starting this slice).

## Not yet verified — deliberately deferred

- **No e2e spec.** There is no seed LCA/PCF job in the synthetic demo data yet, so a discover-a-job e2e spec
  would only ever skip. Adding a seed job (and the e2e spec) is deferred to a slice with enough surface
  (line items at least) to be worth a rendered acceptance pass — mirrors DA1's "backend only, no e2e yet"
  precedent in this same session.
- **No human sensory pass** — same reason; the register UI is real but minimal, better reviewed once line
  items make it a genuinely working surface.

## Flip

Add `NEXT_PUBLIC_FEATURE_JOB_MODULES=job-module-lca` on the Render dashboard + rebuild; add to
`render.yaml`. Needs a seed LCA/PCF job + the deferred e2e spec first (see above) — **not recommended to
flip on the current slice alone**, since there is nowhere in the seed data to see it.

## Rollback

Presentational + additive only. Remove `job-module-lca` (or never set it) — `lca`/`pcf` jobs render via
`FamilyWorkspace` exactly as before. No data / schema change; assessments already created stay in
`lca_assessments`, simply unread while the flag is off.

## Proposed next slices (for confirmation before deep build)

Per `MODEL_FIDELITY_JOB_FAMILIES.md`'s own pipeline ("assessment register → line-item grid → transport legs
→ factor mapping → recalculate → module breakdown chart → report manifest"):

- **L2 — Line-item grid + factor mapping.** CRUD `lca_line_items` under an assessment; factor mapping via
  the **shared** `emission_factors`/`client_factors` (NZC-056) — reusing the CRP factor-select UI pattern,
  not a parallel picker. `data_quality`/gap-fill flags surfaced. No transport legs yet (a placeholder
  quantity/unit per module is enough to prove the model).
- **L3 — Transport legs (+ geocoding).** Multi-leg journeys on transport-module line items. **Needs a
  decision first** — same "propose before building" pattern as DA1's baseline model / R5b's Paged.js
  choice: which geocoding provider (a real API needs a key + a staging-safe deterministic stub, mirroring
  the DVLA-lookup pattern already in `vehicleLookup.ts`), or ship this slice with manual distance entry only
  (`distance_source='manual'`, already schema-supported) and defer geocoding to its own slice.
- **L4 — Recalculate + result snapshots.** The aggregation engine (`module_breakdown`, `hotspots`,
  `mass_reconciliation`) writing `lca_result_snapshots`; the review/sign-off workflow binding
  `review_status` to a `reviewed_version` (NZC-055) — the assessment-level equivalent of CRP's
  approve/reject.
- **L5 — Charts.** Module-breakdown and hotspots charts via `@nzi/charts`, brand-token-styled per the
  visualization subsystem (`GRAPHICS_PIPELINE.md`).
- **L6 — Report manifest + PCF preset labelling.** The family report built from the reviewed snapshot
  (same discipline as CRP's reviewed-snapshot → manifest → immutable release); the PCF preset's UI/report
  copy keeps the "Product Carbon Footprint" term per NZC-039.

Also queued behind this module (per `MODEL_FIDELITY_JOB_FAMILIES.md` §7): the Training module (largest —
products/runs/sessions/bookings/attendance/entitlements/certificates + the CRP↔Training entitlement link),
then Consultancy (lightest), then `FamilyWorkspace.tsx` retirement.
