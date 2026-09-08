# LCA/PCF reference module — slice 7: report manifest + PCF labelling · acceptance

Track C (job-family modularization, NZC-024). Companion: `docs/ACCEPTANCE_LCA_MODULE_SLICE1.md`…`SLICE6.md`,
`docs/REPORT_PRINTING_UX.md` / `docs/STAGING_ACCEPTANCE_R1.md` / `R5*` (the R-track machinery this reuses),
NZC-039 (the "Product Carbon Footprint" term), NZC-051 (the frozen-snapshot rule). Flag: **`job-module-lca`**
— built and carried in `render.yaml`, but the dashboard-authoritative staging flip is still pending per
`docs/DEPLOYMENT.md`. **This is the last build slice — with it, L1–L7 is code-complete.**

## Scope

1. **Freeze the factor-set list into the snapshot** (was deferred from L6 — now done). A professional
   EN 15804 / ISO 14067 deliverable cites the *exact* emission factors, versions and datasets it used, and
   that citation must be bound to what was signed off — not rebuilt from the current mapped lines, which can
   silently drift if a factor or dataset moves after approval.
2. **The LCA/PCF family report** — built **entirely from one frozen result snapshot** (the artefact L4's
   sign-off freezes), reusing the R-track paged machinery (Paged.js "Page view · A4", repeating audit-table
   headers, row-atomic breaks, `PrintButton` + `data-report-ready`) and the L6 charts.
3. **PCF labelling** — NZC-039: a `pcf`-family assessment's report is titled "Product Carbon Footprint" and
   cites `ISO 14067`; an `lca` assessment keeps LCA terminology.

## What's built

### Factor-set freeze (backend + migration)

- **Migration `0056_lca_snapshot_factor_sets.sql`** — `lca_result_snapshots.factor_sets jsonb NOT NULL
  DEFAULT '[]'` (`[{label,version,dataset,originalId}]`). Applied to isolated staging + verified.
- **`packages/contracts/src/jobFamilies.ts`** — `LcaFactorCitation`; `LcaResultSnapshot.factorSets`;
  `LcaResultSnapshot.hotspots[].moduleCode` (so the report is self-contained — the hotspots chart's
  module-group colouring comes from the frozen snapshot, not a live line lookup).
- **`packages/isolated-backend/src/lcaResultSnapshots.ts`** — `gatherFactorCitations(db, org, job,
  assessment)` resolves the distinct dataset / client / manual factor citations across the assessment's
  mapped line items **and** transport legs at freeze time; `createLcaResultSnapshot` persists it into the
  column **and folds it into the content hash** (a factor moving after sign-off genuinely produces a new
  identity). `listLcaResultSnapshots` reads it. New `getLcaReport(db, jobId, snapshotId)` read model +
  `lcaReport` screen contract.

### The report (console)

- **`app/jobs/[jobId]/lca-report/[snapshotId]/page.tsx`** (new) — server-rendered from `getLcaReport`,
  behind `job-module-lca`. Cover (PCF vs LCA title), reviewed-footprint metrics (total + per-functional-unit
  as a presentation-time division), a `ManifestChartSet` of the L6 charts via the `lca` / `pcf` manifest, a
  data-integrity banner (`verifyLcaChartsAgainstSnapshot` — the charts can't disagree with the module
  table), the module-breakdown table, the hotspots table, mass reconciliation, a **frozen "Emission factors
  used" appendix** read verbatim from `snapshot.factorSets`, and the assurance / version record. Wrapped in
  the shared `ReportPagedView` with a `documentTitle`; `buildReportPagedCss` gained an optional
  `documentTitle` (backwards-compatible — CRP unchanged).
- **`LcaWorkspace.tsx`** — `toReviewedLcaSnapshot` now reads the factor citation + hotspot module codes
  from the **frozen snapshot**, not the live lines; each freeze-history row gets an "Open report" link and a
  "N factors cited" note.
- **`app/api/isolated/jobs/[jobId]/lca-report/[snapshotId]/route.ts`** (new).
- **Seed `0010_synthetic_lca_snapshot.sql`** — an approved + frozen snapshot (`snap-714-6l-demo`) on job
  714 so the report and its e2e open against a real artefact. Applied + idempotency-verified.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `createLcaResultSnapshot` freezes the factor citation (dataset + client + manual, from lines **and** legs) into the payload, deduplicated | `lcaResultSnapshots.test.ts` |
| 2 | The factor citation is in the content hash — a changed factor produces a new snapshot identity | design (hash payload includes `factorSets`) + `lcaResultSnapshots.test.ts` |
| 3 | `getLcaReport` joins the snapshot to its assessment/job/client and derives `isPcf` from standard + boundary | `lcaResultSnapshots.test.ts` |
| 4 | An `lca` job's report keeps LCA terminology; a `pcf` job's report is "Product Carbon Footprint" (NZC-039) | `charts/tests/lca.test.ts` (resolver) + e2e |
| 5 | The report renders from the frozen snapshot alone — charts (deterministic SVG, no canvas), module table totalling to the snapshot, the frozen factor appendix verbatim | `tests/e2e/lca-report.spec.ts` |
| 6 | The "Page view · A4" builds from the same paged-media rules as the print path | `lca-report.spec.ts` |
| 7 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `packages/isolated-backend` full suite — 329 green (+1: the factor-freeze test).
- `npm run test -w @nzi/charts` — 22 green.
- `npm run test -w @nzi/console` — 121 green.
- `npm run build -w @nzi/console` — green; `/jobs/[jobId]/lca-report/[snapshotId]` + its API route registered.
- Migration `0056` applied to isolated staging; seed `0010` applied + idempotency-verified; the report
  read-model join checked against staging (returns J000714 / Verdant Foods / 5 frozen factors).

## Not yet verified — deferred

- **No PDF byte-check** — the report reuses R1's print-hardened path and R5b's Paged.js preview, both
  already accepted for CRP; an actual LCA PDF hasn't been generated in CI. `data-report-ready` gates the
  print action exactly as CRP's does.
- **Human sensory pass** — Francis's gate, on the rendered report + the whole L1–L7 module on the seeded
  job.

## Module complete

L1 Model Register · L2 Inventory · L3 Transport legs · L4 calc engine + review + snapshots · L5 Scenarios ·
L6 Charts · L7 Report + PCF labelling — all merged behind `job-module-lca`, seeded end-to-end on jobs
714/715. Next (NZC-024): flip and prove it on the seeded job, then replicate the pattern to the Training and
Consultancy families and retire `FamilyWorkspace.tsx`.
