# LCA/PCF reference module — slice 6: charts · acceptance

Track C (job-family modularization, NZC-024). Companion: `docs/GRAPHICS_PIPELINE.md`, `docs/ARCHITECTURE.md`
§7, `docs/ACCEPTANCE_LCA_MODULE_SLICE1.md`…`SLICE5.md`, `docs/STAGING_ACCEPTANCE_R1.md` (the R1 print-safe
chart pack this reuses). Flag: **`job-module-lca`** — live on staging.

## Scope

Two deterministic, print-safe SVG charts for the LCA/PCF result, built through the **shared `@nzi/charts`
engine** — the same one CRP uses — from the **reviewed/frozen result snapshot** (the L4
`lca_result_snapshots` row), never from a request-time canvas:

- **`lca_module_donut`** — cradle-to-X footprint by EN 15804 module, coloured by module group
  (product / transport / use / end-of-life / benefits), with a legend + share tracks and a centre total.
- **`lca_hotspots_bar`** — the line items contributing most to the total, horizontal bars coloured by the
  line's module group, with value + share.

Both carry the snapshot's `dataHash` as their content-addressed identity and go through the same
`ManifestChartSet` + `validateManifest` publication gate, so they can't disagree with the module-breakdown
table beside them (`verifyLcaChartsAgainstSnapshot`).

## What's built (`packages/charts`)

- **`types.ts`** — `lca_module_donut` / `lca_hotspots_bar` chart types, `LcaModuleGroup`, `LcaModuleDonutData`
  / `LcaHotspotsBarData`, both in `AnyChartData`.
- **`tokens.ts`** — `moduleGroupColor(group)` using hexes already in the palette (product → emerald, then the
  site categorical slots) — **no new token, `TOKENS_VERSION` unchanged**, so existing CRP chart identities
  are undisturbed.
- **`LcaModuleDonut.tsx`** / **`LcaHotspotsBar.tsx`** (new) — pure/stateless SVG, mirroring
  `EmissionsScopeDonut` / `EmissionsByActivity`. Identical on screen and in print; identity never
  colour-alone (2px gaps, direct labels, legend, `desc`).
- **`lca.ts`** (new) — `resolveLcaCharts(snapshot)` → `[donut, bar]`, `LCA_RESOLVER_VERSION`,
  `lcaProfessionalManifest` (family `lca`) + `pcfProfessionalManifest` (family `pcf`). The resolver reads
  `snapshot.isPcf` and titles the donut "Product Carbon Footprint by life-cycle module" for PCF, "Life-cycle
  emissions by life-cycle module" for LCA (NZC-039 — kept for L7).
- **`ManifestChartSet.tsx`** — the two new types wired into `ChartFromManifest`.
- **`verify.ts`** — `verifyLcaChartsAgainstSnapshot`: the donut total = `snapshot.totalTco2e`, Σ segments =
  Σ `moduleBreakdown`, each segment = its `moduleBreakdown` entry, and the hotspots bar can never claim
  more than the total.
- **`sample.ts`** — `reviewedLcaSnapshotSample` (job 714) + `lcaChartSamples`.

## What's built (`apps/console`)

- **`LcaWorkspace.tsx`** — the `AssessmentResults` snapshot section renders `<LcaModuleDonut>` +
  `<LcaHotspotsBar>` from the latest frozen snapshot (`toReviewedLcaSnapshot` maps the L4 snapshot + the
  live assessment header; the snapshot's `dataHash` is the real identity, surrounding labels come from the
  assessment, factor sets are derived from the mapped lines). Empty state tells the user to freeze a
  snapshot first.
- **`app/charts/page.tsx`** — an LCA `ManifestChartSet` block on the `/charts` demonstrator alongside CRP.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | One reviewed LCA snapshot resolves a publishable chart set; both charts share one `dataHash` | `charts/tests/lca.test.ts` |
| 2 | A PCF snapshot resolves against the PCF manifest, keeps the "Product Carbon Footprint" label, and the LCA manifest rejects a PCF-family chart set | `lca.test.ts` |
| 3 | An empty module breakdown → `state: "empty"` and a blocked manifest, not a silent zero | `lca.test.ts` |
| 4 | Every chart figure reconciles to the reviewed snapshot; a drifted segment fails verification | `lca.test.ts` |
| 5 | Both charts render to deterministic static SVG server-side — no `<canvas>` | `lca.test.ts` (`renderToStaticMarkup`) |
| 6 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `npm run test -w @nzi/charts` — 22 green (8 new in `lca.test.ts`).
- `npm run test -w @nzi/console` — 121 green.
- `npm run build -w @nzi/console` — green.
- No new migration; no backend change — L6 is chart-package + presentation only.

## Not yet verified — deferred

- **No PDF/print smoke** — the charts are proven deterministic (server `renderToStaticMarkup`, stable asset
  keys) and reuse R1's print-hardened path, but an actual LCA report PDF isn't generated until L7.
- **Factor-set provenance is derived, not frozen** — the L4 `lca_result_snapshots` row has no factor-sets
  column, so the chart footer's factor list is rebuilt from the assessment's current mapped lines. The
  `dataHash` identity is real; the label is best-effort. L7 can fold a frozen factor-set list into the
  snapshot if the report needs it verbatim.

## Next

**L7 — Report manifest + PCF labelling**: the family report built from the same frozen snapshot, reusing the
R-track machinery (deterministic SVG charts — done here — paged output / repeating headers / Paged.js
page-view, and the section model), with the NZC-039 "Product Carbon Footprint" label for pcf jobs.
