# R1 — print-safe report chart pack · staging acceptance record

Gate: `docs/ACCEPTANCE_R1_PRINT_SAFE_CHARTS.md`. Decision **NZC-050**. Flag `report-svg-charts` in
`NEXT_PUBLIC_FEATURE_REPORT_STUDIO`.

## Flip

`report-svg-charts` appended to the Render dashboard `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` value and the
rebuild deployed — **3 Sep 2026** (Francis, alongside the R1 PR #76 deploy). Confirmed live: the report
version page for the seeded published report (`J000712`, snapshot `8a01e16b…`) serves
`.report-sheet[data-report-ready="true"]`, the green data-integrity banner, and a `SVG · print-safe`
marker on every chart.

## Automated gate — PASS (3 Sep 2026, deployed staging)

Ran `apps/console/tests/e2e/report-print-safe.spec.ts` against `https://nzi-pro-api-prod.onrender.com`
(acceptance accounts provisioned from `.env.local`).

The spec is **hardened** — no conditional skip on the R1 markers (a conditional skip is how the
`job-stage-sections` flip went unverified for days). It discovers a published report version, fails loudly
if there is none, and hard-asserts:

| Check | Result |
|---|---|
| `.report-sheet[data-report-ready="true"]` present | ✅ |
| Charts are inline `<svg>`; **no `<canvas>`** anywhere on the page | ✅ |
| `SVG · print-safe` marker count == rendered chart count | ✅ |
| Data-integrity banner visible, **not** `.fail`, text "every chart figure matches Outputs" | ✅ |
| No uncatalogued serious/critical axe violations (`report-print-safe` baseline) | ✅ |
| No horizontal overflow at 390 / 768 / 1280 / 1920 | ✅ |
| No console errors / 5xx | ✅ |

`report-print-safe.spec.ts` — **2/2 pass**. Full suite with `report-svg-charts` + `job-stage-sections`
live: **50 passed / 10 skipped / 0 failed**.

Unit: `packages/charts/tests/verify.test.ts` — 3/3 (`verifyChartsAgainstSnapshot` reconciles a good
snapshot, fails a drifted figure, skips non-success charts).

## Gate status

| Gate item | State |
|---|---|
| 1 · Five-state screen; a failed snapshot read is never a zeroed report | ✅ e2e |
| 2 · `.report-sheet[data-report-ready="true"]` after load | ✅ e2e |
| 3 · Inline `<svg>` charts, no `<canvas>` | ✅ e2e |
| 4 · `SVG · print-safe` marker on every chart | ✅ e2e |
| 5 · Data-integrity banner green, "every chart figure matches Outputs" | ✅ e2e |
| 6 · `verifyChartsAgainstSnapshot` unit coverage | ✅ 3/3 |
| 7 · axe baseline clean on the report surface | ✅ e2e |
| 8 · No horizontal overflow 390/768/1280/1920 | ✅ e2e |
| 9 · typecheck · `@nzi/console` build · `@nzi/charts` tests | ✅ |
| 10 · Flag OFF renders the report as before | ✅ (all R1 branches gated on `reportFeatureEnabled`) |
| 11 · **Human-only:** screen-reader announces the integrity `status`/`alert` banner; a staging-Chromium PDF waits on `data-report-ready` and the output charts match the on-screen SVG | ⏳ Francis |

## Rollback

Remove `report-svg-charts` from `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` + rebuild — the report renders as it did
before R1. `report-print-safe.spec.ts` then fails loudly (by design); pair a rollback with reverting/skipping
the spec. No data, route or schema change.
