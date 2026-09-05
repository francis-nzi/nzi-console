# LCA/PCF reference module — slice 4: gap-filling, the calc engine, review & result snapshots · acceptance

Track C (job-family modularization, NZC-024). Companion: `docs/MODEL_FIDELITY_JOB_FAMILIES.md` §2/§6,
`docs/ACCEPTANCE_LCA_MODULE_SLICE1.md`…`SLICE3.md`. Decisions **NZC-055** (review spine). Flag:
**`job-module-lca`** in `NEXT_PUBLIC_FEATURE_JOB_MODULES` — unchanged, this slice adds surface behind the
same token.

## Scope of this slice

This is where the numbers stop being an honest zero. Four capabilities, together "the LCA analogue of the
Data Assurance gate" (Francis's framing):

1. **Gap-filling** — mark a genuinely unmapped line item as a documented proxy (`is_gap_filled`, a method
   note, `data_quality` defaulting to `proxy`). Mirrors CRP's `assurance.gap.resolve`. Rejects a placeholder
   row (nothing to fill) and an already-mapped line (edit it directly instead).
2. **The calc engine** — `lca.assessment.calculate` resolves every line item's and transport leg's factor
   mapping into a `calculated_kgco2e`, recomputes the module breakdown / hotspots / mass reconciliation /
   total, and **resets review to pending** (a recalculation invalidates any prior sign-off — same as
   `scope.row.calculate` does for CRP). The per-item maths mirrors the CRP convention (`quantity × the
   factor's kgCO2e-per-unit`, with a unit-match check for dataset/client factors).
3. **Independent review** — `lca.assessment.review.approve` / `.reject`, one level up from CRP's per-row
   review (a whole assessment is what a report cites). Binds `review_status` to `reviewed_version` exactly as
   the `lca_assessment_reviewed_shape` CHECK requires.
4. **Content-addressed result snapshots** — `lca.assessment.snapshot.create` freezes the current result into
   an immutable `lca_result_snapshots` row, hashed with the same stable-JSON discipline as
   `reviewed_crp_snapshots` (idempotent re-use when nothing changed). **Gated on `review_status='approved'`.**

**Not in this slice**: scenarios (L5), charts (L6), the report manifest + PCF labelling (L7).

## Engine parity — resolved against the live engine (correction PR `fix/lca-engine-parity`)

L4 shipped with three disclosed interpretation calls. Francis reviewed the live engine
(`NZI Live/services/lca_engine.py` + `lca_transport.py`) and supplied the exact rules in
`docs/_handoff_LCA_engine_parity.md` (deleted once the correction landed — see git history). Outcome:

- **Ordering — kept.** `calculate → review → freeze` is correct; the `NOT_APPROVED` gate stays.
- **Functional-unit scaling — REMOVED (was wrong).** `total_tco2e` is now the plain sum of absolute line
  emissions ÷ 1000 (line quantities are always kg, converted per the factor denominator). Per-functional-unit
  is `total ÷ functional_unit_value`, computed at presentation only (`perFunctionalUnitTco2e` in the calc
  result, shown in the UI, never stored/frozen).
- **Transport legs — CORRECTED (was a bug).** The freight defaults are tonne.km, so "straight ×
  distance_km" under-counted by ~1000×. `lcaUnits.transportLegKgco2e` now branches on the factor's
  DENOMINATOR unit: `tonne.km` → mass_t × dist_km × factor; `tonne.mile` → mass_t × dist_mi × factor;
  `mile` → dist_mi × factor (mass-independent); `km`/other → dist_km × factor. `lineItemKgco2e` applies the
  `material_basis` (kg↔tonne) and `ghg` (kg/tonne/g CO2e numerator) multipliers from §2/§3 — an odd unit is
  normalised, not zeroed (the strict unit-match check is gone). A manual leg (no unit column) is treated as
  the mass-independent per-km branch.
- **Mass reconciliation — A1 basis confirmed.** `capturedMassKg` = the A1 (raw-material) module's mass-based
  line quantities (`MASS_RECONCILIATION_MODULE = "A1"`); material assessments only (`null` for service).

All the unit maths now lives in `packages/isolated-backend/src/lcaUnits.ts` (pure, `lcaUnits.test.ts`), so
the line-items path, the calc engine and any future report path go through one resolver.

## What's built

- **`packages/contracts/src/jobFamilies.ts`** — `LcaAssessment` gains `reviewedBy`/`reviewedAt`/
  `reviewerNote`/`lastCalculatedAt`; new `LcaGapFillWriteFields`.
- **`packages/contracts/src/commands.ts`** — `lca.lineItem.gapFill` (permission `emissions.data.edit`),
  `lca.assessment.calculate` (`emissions.data.edit`), `lca.assessment.review.approve` / `.reject`
  (`emissions.review`, reused), `lca.assessment.snapshot.create` (`reports.publish`, reused). All
  optimistically locked on the assessment version except gap-fill (operates on `lca_line_items`, which has
  no version — last-write-wins, same as slice 2).
- **`packages/isolated-backend/src/lcaLineItems.ts`** — `gapFillLcaLineItem`.
- **`packages/isolated-backend/src/lcaCalcEngine.ts`** (new) — `calculateLcaAssessment` +
  `computeLcaAssessmentResult` (a pure "summarize what's currently stored" read, shared by the calc command
  and the snapshot command so the two can't drift).
- **`packages/isolated-backend/src/lcaAssessmentReview.ts`** (new) — `approveLcaAssessment` /
  `rejectLcaAssessment`.
- **`packages/isolated-backend/src/lcaResultSnapshots.ts`** (new) — `createLcaResultSnapshot` (hash,
  idempotent re-use, `NOT_APPROVED` gate) + `listLcaResultSnapshots`.
- **API routes** — `POST .../line-items/{id}/gap-fill`, `POST .../{assessmentId}/calculate`, `POST
  .../{assessmentId}/review/approve` + `/reject`, `GET/POST .../{assessmentId}/snapshots`.
- **`apps/console/app/jobs/lca/LcaWorkspace.tsx`** — an `AssessmentResults` panel inside the Inventory
  expansion: current total + last-calculated + review status, a Recalculate button (shows the fresh module
  breakdown / hotspots / mass reconciliation), Approve / Reject (with a required note) / Freeze snapshot
  buttons, and the freeze history. Gap-fill is an inline action on every unmapped non-placeholder line. The
  calculate → review → freeze chain tracks the assessment version off each command's response so a slow
  `router.refresh()` can't wedge the next step.
- **`packages/isolated-backend/seeds/0007_synthetic_lca_calc.sql`** (new) — adds kg-based material factors
  to the synthetic GB dataset, selects it for jobs 714/715, and re-points the seeded dataset-mapped line
  items at real ids (the L2 seed's ids were invented and the LCA jobs never got a `job_dataset_selections`
  row), so "Recalculate" on staging produces a genuine breakdown, not zeros. Verified in place. Transport
  legs stay unmapped on purpose — the recalculated result honestly shows a partially-mapped assessment.
- **e2e** — `tests/e2e/lca-calc-review.spec.ts` (new; recalculate → breakdown, then gap-fill → recalculate →
  approve → freeze; one conditional skip for the flag not yet being live).

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `gapFillLcaLineItem` fills an unmapped line; rejects a placeholder (`PLACEHOLDER`), an already-mapped line (`ALREADY_MAPPED`), an unknown line, a negative value, a blank method | `lcaLineItems.test.ts` |
| 2 | `calculateLcaAssessment` resolves dataset (unit-checked), manual and unmapped line items; leaves unmapped/placeholder alone | `lcaCalcEngine.test.ts` |
| 3 | It resolves transport legs (manual × distance, dataset × distance) and sums them onto the parent line's `transport_kgco2e` | `lcaCalcEngine.test.ts` |
| 4 | It resets review to pending, bumps the assessment version, and a stale `expectedVersion` is a conflict | `lcaCalcEngine.test.ts` |
| 5 | `computeLcaAssessmentResult` scales per-unit kg by `functionalUnitValue`, converts to tonnes, ranks hotspots, and reconciles mass excluding transport-line quantity | `lcaCalcEngine.test.ts` |
| 6 | `approveLcaAssessment` / `rejectLcaAssessment` bind `reviewed_version`; reject requires a note; stale version is a conflict | `lcaAssessmentReview.test.ts` |
| 7 | `createLcaResultSnapshot` freezes an approved assessment, reuses an identical hash instead of duplicating, and rejects a pending/rejected assessment (`NOT_APPROVED`) | `lcaResultSnapshots.test.ts` |
| 8 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `npm run test -w @nzi/console` — 121 green (unchanged; L4 logic is server-side).
- `packages/isolated-backend` full suite — 300 green (24 new: 5 gap-fill, 5 calc engine, 5 review, 5
  snapshots + adjustments to existing LCA tests).
- `npm run build -w @nzi/console` — green, all new routes registered.
- No new migration — Phase 0's `0046`/`0047` already have `lca_line_items` (gap-fill columns),
  `lca_assessments` (review + `last_calculated_at`) and `lca_result_snapshots`.
- `0007_synthetic_lca_calc.sql` applied to isolated staging and re-applied for idempotency; the calc
  engine's dataset-factor join verified to resolve (unit-matched) for all four seeded dataset lines.

## Not yet verified — deliberately deferred

- **No human sensory pass on rendered staging** — the flag is not yet live on the target (unchanged from
  slices 2–3). The e2e spec's hard-precondition checks are the strongest verification available until it
  flips.
- **The calc engine has not been exercised end-to-end against real staging data by a command call** — the
  unit tests mock the pool; the seed's factor-resolution join was checked with a direct SQL query, but no
  `calculateLcaAssessment` has actually run against staging this session (it needs a real command principal).
  The e2e spec is written to do exactly this once the flag flips.

## Flip

Same variable and readiness as slices 2–3 — `job-module-lca` in `NEXT_PUBLIC_FEATURE_JOB_MODULES`, seeded
(now including calc-ready factors) and ready; the Render dashboard edit + rebuild remains a manual step
needing a human with Render access. `tests/e2e/lca-calc-review.spec.ts` has one conditional `test.skip` for
the flag not yet being live; delete it at the flip PR (along with the two from slices 2–3).

## Rollback

Presentational + additive only. Remove `job-module-lca` — `lca`/`pcf` jobs render via `FamilyWorkspace`.
Calculated `calculated_kgco2e` values and any frozen `lca_result_snapshots` stay in place, simply unread
while the flag is off; `lca_result_snapshots` has no UPDATE/DELETE grant, so a frozen snapshot is immutable
regardless.

## Next slices

**L5 — Scenarios** (what-if module multipliers + scenario comparison; `lca_scenarios` /
`lca_scenario_multipliers` schema is already in Phase 0). Per the plan, L5 onward gets a status check-in
with Francis before deep build (L2–L4 were the pre-authorized run). Then **L6 Charts**, **L7 Report
manifest + PCF labelling**.
