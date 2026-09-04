# R1 — print-safe report chart pack · acceptance

Spec: `docs/REPORT_PRINTING_UX.md` §1 (and §5). Decision **NZC-050**. Reference prototype:
`docs/prototypes/report_v3.html` (`donut()`, `bars()`, the `SVG · print-safe` tag, the integrity banner).

**Flag:** `report-svg-charts`, a token in **`NEXT_PUBLIC_FEATURE_REPORT_STUDIO`** (its own variable, parallel
to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`; OFF by default; `apps/console/app/lib/reportFlags.ts`). Build-time
inlined — a flip is a Render dashboard edit + rebuild (`docs/DEPLOYMENT.md` §"Feature-flag flips"). With the
flag off the report version page renders exactly as before.

## What R1 delivers

The console already renders report charts as derived, deterministic inline SVG (`@nzi/charts` +
`ManifestChartSet`, proven server-side in the Render build). R1 adds the guarantees the spec asks for on
top of that:

1. **One deterministic render-ready signal.** `.report-sheet[data-report-ready="true"]` is set server-side
   once every section and every chart SVG is in the DOM, the manifest validates, and every chart figure
   reconciles to Outputs. It is the *only* thing a PDF/print step waits on — no arbitrary sleeps. If any
   check fails the attribute is `"false"` and `PrintButton` blocks the print and scrolls to the banner.
2. **Chart-inclusive data-integrity check.** `verifyChartsAgainstSnapshot` (in `@nzi/charts`) recomputes
   each chart's headline figure(s) straight from the reviewed snapshot `measurements` and reconciles them
   to what the chart carries: scope-donut total + three subtotals, site-donut total, activity-breakdown
   sum, purchased-goods (Scope 3.1) sum, and the reduction/intensity pathway baseline vs the frozen target.
   The green banner — *"Data integrity check passed — every chart figure matches Outputs (N checks)"* —
   extends the existing totals/categories/rows guarantee to charts. A failed check renders a distinct
   `role="alert"` failure banner listing the mismatches; it is never shown as a pass (five explicit states).
3. **Visible "SVG · print-safe" marker** on every chart card, so consultants can see the print-hardened
   path is in use. Screen-only — suppressed in `@media print` along with the banner.
4. **Print CSS unchanged in intent**, still `break-inside: avoid` on figures; `@page` A4; toolbar and the
   R1 chrome hidden in print.

## Gate

Behind `report-svg-charts` ON, on isolated staging, a staff user opening a CRP report version
(`/reports/{versionId}`):

| # | Gate item | Check |
|---|---|---|
| 1 | Five-state screen: a failed snapshot read is never a zeroed report | `expectHealthyScreen` |
| 2 | `.report-sheet[data-report-ready="true"]` present once the page has loaded | e2e |
| 3 | Charts are inline `<svg>` in the server markup; **no `<canvas>`** anywhere | e2e |
| 4 | Every chart card carries a visible `SVG · print-safe` marker (count == chart count) | e2e |
| 5 | Data-integrity banner visible, **not** `.fail`, text "every chart figure matches Outputs" | e2e |
| 6 | `verifyChartsAgainstSnapshot` unit coverage: reconciles a good snapshot; fails a drifted figure; skips non-success charts | `packages/charts/tests/verify.test.ts` (3/3) |
| 7 | No uncatalogued serious/critical axe violations on the report surface | `scanWithBaseline(page, "report-print-safe")` |
| 8 | No horizontal overflow at 390 / 768 / 1280 / 1920 | `expectNoHorizontalOverflow` |
| 9 | `npm run typecheck` clean · `@nzi/console` build · `@nzi/charts` tests green | ✅ pre-flip |
| 10 | Flag OFF renders the report byte-for-byte as before (no banner, no marker, no `data-report-ready`) | manual diff + e2e skip path |
| 11 | **Human-only:** screen-reader announces the integrity `status`/`alert` banner; print/PDF from staging Chromium waits on `data-report-ready` and the output charts match the on-screen SVG | Francis |

## Automated suite

- `packages/charts/tests/verify.test.ts` — 3 tests (see gate #6).
- `apps/console/tests/e2e/report-print-safe.spec.ts` — 2 tests (gate #2–#5, #7–#8). Skips until
  `report-svg-charts` is live on the target (report sheet has no `data-report-ready`).

## Pre-flip verification (Claude Code, this branch)

- `npm run typecheck` — clean across all workspaces.
- `npm run build -w @nzi/console` — green (`/reports/[versionId]` compiles).
- `npm run test -w @nzi/charts` — 15/15 (12 existing + 3 new).
- Flag OFF: report page output unchanged (the R1 branches are all gated on `reportFeatureEnabled("report-svg-charts")`).

## Flip

Append `report-svg-charts` to `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` in the Render dashboard (create the var
if absent) + rebuild; also add it to `render.yaml` for continuity. Then run
`apps/console/tests/e2e/report-print-safe.spec.ts` against deployed staging and record the result plus the
human pass (gate #11) in `docs/STAGING_ACCEPTANCE_R1.md`.

## Rollback

Presentational and purely additive. Remove the token from `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` + rebuild;
the report renders as it does today. No data, route or schema change.
