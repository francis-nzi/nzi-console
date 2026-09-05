# LCA/PCF reference module — slice 2: the Inventory · acceptance

Track C (job-family modularization, NZC-024). Decisions **NZC-053/054/056** (already confirmed 1 Sep 2026;
this slice is implementation, not new decisions). Companion: `docs/MODEL_FIDELITY_JOB_FAMILIES.md` §2/§6/§7,
`docs/ACCEPTANCE_LCA_MODULE_SLICE1.md` (slice 1, the Model Register). Flag: **`job-module-lca`** in
`NEXT_PUBLIC_FEATURE_JOB_MODULES` — unchanged from slice 1, this slice adds surface behind the same token.

## Corrected slicing (5 Sep 2026)

Slice 1's "proposed next slices" pipeline is superseded by a review of the live LCA product, which is a
mature seven-stage workflow (goal-scope → inventory → factor-mapping → gap-filling → impact → scenarios →
reporting). The confirmed order from here:

- **L2 · Inventory (this slice)** — folds the live app's *inventory* and *factor-mapping* stages into one
  (consistent with the CRP "mapping at capture" decision): line items grouped by EN 15804 module, manual add
  plus BOM bulk-paste import, a component-library quick-pick, and per-line factor mapping against the shared
  factor library.
- **L3 · Transport legs** — modules A2/A4/C2 only; origin/destination, distance, transport factor, per-mode
  freight quick-picks, Nominatim geocoding behind a deterministic staging stub (mirrors `vehicleLookup.ts`),
  manual distance override always available.
- **L4 · Gap-filling + calc + snapshot + review** — proxy/gap-fill missing line items, the calc engine
  (module breakdown + hotspots), a content-addressed result snapshot on sign-off (reusing the governance
  spine + the Data Assurance freeze pattern), then independent review.
- **L5 · Scenarios** — what-if modelling with per-module multipliers and scenario comparison.
- **L6 · Charts** — module-breakdown donut/bars via `@nzi/charts`.
- **L7 · Report manifest + PCF labelling** — the family report; PCF preset keeps the "Product Carbon
  Footprint" term (NZC-039).

**Disclosure:** this slice (and L3/L4 to follow) is built from Francis's description of the live product and
`MODEL_FIDELITY_JOB_FAMILIES.md`, not from the live NZI Pro source directly — the local path this session
had for the live repo (`nzi-pro`) is an empty git init, not an actual checkout, so files named in the brief
(`frontend/src/components/JobLca.tsx`, `services/geocoding.py`, `services/lca_transport.py`,
`services/lca_engine.py`, `services/lca_bom_template.py`, `services/lca_component_tree.py`,
`services/lca_material_categories.py`, `sql_migrations/0058_lca_pcf_rebuild.sql`) were not readable this
session. L3's exact `FREIGHT_DEFAULT_FACTORS` per-mode values are needed from Francis (or a working checkout)
for live parity; L3 will ship with a clearly-flagged placeholder set otherwise.

## Scope of this slice

The **flat inventory** under an assessment: line items grouped by EN 15804 module (A1→D order, limited to
the assessment's `includedModules`), a manual add form, a component-library quick-pick (fuzzy search,
prefills label/unit/origin/mass), a BOM bulk-paste import (reusing the fast-add/template pattern —
`fuzzyScore` from `templateSearch.ts`, the paste→parse→confirm→import shape from `VehicleBulkPanel.tsx`),
and per-line factor mapping against the **shared** `emission_factors`/`client_factors` (a fuzzy-searchable
picker over the job's existing factor library — no parallel lookup). **Not in this slice**: transport legs
(+ geocoding), gap-filling as a distinct workflow (the schema flags exist and are surfaced read-only;
nothing in this slice *sets* `is_gap_filled` from an automated proxy run), the calc engine / result
snapshots, scenarios, charts, and the report manifest.

## What's built

- **`packages/contracts/src/jobFamilies.ts`** — `LcaLineItem` gains `factorUnit`/`notes` (columns that
  existed in the Phase-0 schema but not the original type); adds `LcaLineItemWriteFields` (the editable
  subset) and `LcaComponentOption` (the component-library pick-list shape, mirrors `ClientFactorRecord`).
- **`packages/contracts/src/commands.ts`** — `lca.lineItem.create` / `.update` / `.delete` /
  `.bulkCreate`, permission `emissions.data.edit` (reused). Validation: label required, module code against
  `lcaModuleCodes`, quantity ≥ 0, unit required, per-factor-source required-field cross-checks (dataset →
  factorId + datasetId; client → clientFactorId; manual → factorValue), `dataQuality` enum.
  `bulkCreate` validates every line and reports per-line-indexed field errors (`lines.1.lineLabel`).
- **`packages/isolated-backend/src/lcaLineItems.ts`** (new) — `listLcaLineItems` /
  `listLcaLineItemsByAssessments` (batched, avoids N+1 when the register lists several assessments) /
  `createLcaLineItem` / `bulkCreateLcaLineItems` / `updateLcaLineItem` / `deleteLcaLineItem` /
  `listLcaComponentsForJob` / `listLcaMaterialCategories`. No `version` column on `lca_line_items` (unlike
  `lca_assessments`) — `updateLcaLineItem` is last-write-wins by design, matching the Phase-0 schema, not an
  oversight.
- **`packages/isolated-backend/src/lcaAssessments.ts`** — `listLcaAssessments` now attaches each
  assessment's real `lines` (was always `[]` in slice 1); `scenarios` stays `[]` honestly (no command
  creates any yet — that's L5).
- **API routes** — `GET/POST /jobs/{jobId}/lca-assessments/{assessmentId}/line-items`, `PATCH/DELETE
  .../line-items/{lineItemId}`, `POST .../line-items-bulk`, `GET /jobs/{jobId}/lca-components` (bundles
  components + material categories — one request, one `lcaComponents` screen contract).
- **`packages/contracts/src/index.ts`** — new `lcaComponents` `ScreenKey`/contract (small pick-list,
  `isEmpty: () => false`, same convention as `sites`/`purchasedGoodsCategories`).
- **`apps/console/app/jobs/lca/LcaWorkspace.tsx`** — each Model Register row gets an "Inventory" toggle; the
  expanded panel groups lines by module, shows a factor-status chip (`Unmapped`/`Manual value`/`Mapped`),
  gap-filled/excluded badges, a manual add form (`ComponentPicker` + `FactorPicker`, both fuzzy-searchable
  comboboxes reusing `fuzzyScore`), and a BOM bulk-paste import panel.
- **`apps/console/app/jobs/lca/lcaBomImport.ts`** (new) — pure BOM-paste parsing (`parseLcaBomLines`,
  `matchModuleCode`), mirrors `vehicleBulk.ts`'s column-sniffing convention; unit-tested standalone
  (`tests/lcaBomImport.test.ts`, 9 tests).
- **`apps/console/app/jobs/[jobId]/page.tsx`** — loads `lcaComponents` alongside `lca`; the LCA branch now
  also passes down the job's `factors` (already loaded for the CRP branch) and the component/category
  lists.
- **`packages/isolated-backend/seeds/0005_synthetic_lca_pcf.sql`** (new) — seeds a Model Register assessment
  + a representative set of inventory lines (mapped/unmapped/manual+gap-filled/placeholder-excluded) onto
  the **existing** seed jobs `714` (lca) and `715` (pcf) from `0001_synthetic_demo.sql` — no new job rows;
  plus material categories and a component library (one client-scoped, one global) for the quick-pick
  search. Applied to isolated staging and re-applied to confirm idempotency.
- **e2e** — `tests/e2e/lib/discover.ts` gains `discoverLcaJob`; `tests/e2e/lca-inventory.spec.ts` (new,
  hard-precondition-once-live discipline, one conditional skip for the flag not yet being live — see Flip).

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `createLcaLineItem`/`bulkCreateLcaLineItems` reject an unknown assessment, a blank label, an invalid module code, a dataset factor with no dataset id | `lcaLineItems.test.ts` |
| 2 | `bulkCreateLcaLineItems` creates every line in one command and rejects an empty batch, reporting per-line-indexed errors | `lcaLineItems.test.ts` |
| 3 | `updateLcaLineItem`/`deleteLcaLineItem` reject an unknown line item; update is last-write-wins (no version column on this table) | `lcaLineItems.test.ts` |
| 4 | `listLcaLineItems` maps factor unit, gap-fill and placeholder flags correctly; `transportLegs` always `[]` (L3) | `lcaLineItems.test.ts` |
| 5 | `listLcaAssessments` attaches each assessment's own lines, never another's; `scenarios` stays `[]` | `lcaAssessments.test.ts` |
| 6 | `listLcaComponentsForJob`/`listLcaMaterialCategories` return client-scoped and global entries alike | `lcaLineItems.test.ts` |
| 7 | `parseLcaBomLines` handles a header row, a header-less paste, blank/junk rows, and an unrecognised module (left for the operator) | `lcaBomImport.test.ts` |
| 8 | Flag OFF: `job.header.family==="lca"` renders `FamilyWorkspace` exactly as before (unchanged from slice 1) | code review |
| 9 | `npm run typecheck` (all workspaces) · full unit suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `npm run test -w @nzi/console` — 121 tests green (includes the new 9 `lcaBomImport.test.ts` tests).
- `packages/isolated-backend/tests/lcaAssessments.test.ts` (8) + `lcaLineItems.test.ts` (11) — 19 tests green,
  run standalone via `node --import tsx --test`.
- No new migration — Phase 0's `0045`–`0047` already has everything this slice reads/writes.
- `packages/isolated-backend/seeds/0005_synthetic_lca_pcf.sql` applied to isolated staging (and re-applied
  to confirm the `ON CONFLICT DO NOTHING` idempotency); verified in place by direct query (assessments,
  lines and components all present with the expected shapes).

## Not yet verified — deliberately deferred

- **No human sensory pass on rendered staging** — the flag is not yet live on the target (see Flip); the
  e2e spec's own hard-precondition check is the strongest verification available until it flips.
- **Factor picker is not exercised end-to-end against real dataset/client factors on staging** — the picker
  reads the job's real factor library (`listJobFactorOptions`) and unit tests confirm the write path accepts
  `factorId`/`clientFactorId`/`factorValue` correctly per source, but no e2e test drives a factor pick yet
  (deferred to keep this slice's spec focused on the shapes the seed already demonstrates: mapped, unmapped,
  manual+gap-filled, placeholder).

## Flip

Same variable as slice 1 — `job-module-lca` in `NEXT_PUBLIC_FEATURE_JOB_MODULES`. **Ready to flip as of this
slice**: the seed-fixture blocker is resolved (see above), `render.yaml` carries the continuity value. The
actual Render dashboard edit + rebuild is a manual step outside this agent's tooling — needs a human with
Render access. `tests/e2e/lca-inventory.spec.ts` has one conditional `test.skip` for the flag not yet being
live; delete that one call as part of the flip PR, per this suite's established discipline.

## Rollback

Presentational + additive only. Remove `job-module-lca` (or never set it) — `lca`/`pcf` jobs render via
`FamilyWorkspace` exactly as before. No data / schema change; line items already created stay in
`lca_line_items`, simply unread while the flag is off.

## Next slices

Per the corrected order above: **L3 — Transport legs (+ Nominatim geocoding, deterministic staging stub)**,
then **L4 — Gap-filling + calc engine + result snapshot + review**. Both pre-authorized to build straight
through (Francis, 5 Sep 2026) — L5 (Scenarios) onward gets a status check-in before deep build.
