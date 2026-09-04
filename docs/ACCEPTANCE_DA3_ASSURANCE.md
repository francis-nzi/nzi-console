# DA3 — Data Assurance stage (Review & QA → assurance surface) · acceptance

Track: **M8 · Data Assurance**. Decisions **NZC-059 / NZC-060**. Prototype: `docs/prototypes/review_qa_v1.html`.
Flag: **`data-assurance`** in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`. Consumes the DA1 backend
(`GET /api/isolated/jobs/[jobId]/assurance`).

Sliced so the governance-critical piece lands last:

| Slice | Scope | Status |
|---|---|---|
| **DA3a** | Read surface — five-year trend (BL pill always shown, "% vs BL" its own column with the NZC-060 neutral tone), By scope / By site / Audit / Intensity tabs, CSV export. Read-only. | 🟢 built (PR #86) |
| DA3b | Right overlay drawer (table keeps full width; reopen tab) — gaps list, resolve-with-reason via `assurance.gap.resolve` (optimistic + `expectedVersion`), "fix the row" round-tripping `computeAssuranceGaps`; drawer doubles as the shared row-detail drawer | ⏳ |
| DA3c | Row approvals in-stage + **governed sign-off** — the gate (blocked while any gap open **or** any enabled row unapproved) → `report.snapshot.create` freezing the snapshot (+ the frozen `gapResolutions`), reviewer + timestamp. **Integration outline posted for Francis before deep build.** | ⏳ |

## DA3a — the read surface

`CrpAssuranceStage` renders in the **Review & QA** `StageSection` when `data-assurance` is on.

- **Header** — Total + Scope 1/2/3 for the current year; baseline year + **BL pill** (or a prompt to set a
  reduction target when there is no baseline); reporting year.
- **Integrity banner** — `N gaps to resolve` ↔ `Data integrity check passed`, with per-flag chip counts.
- **Five-year trend** (`table.nz-assurance-trend`) — Scope · Category · one column per chain year
  (`[baseline BL]`, priors, `[current]`, baseline + current tinted) · **`% vs BL`** = current ÷ baseline − 1,
  toned via `percentVsBaselineTone` (**neutral grey** when a reduction is driven by an unresolved
  completeness / zero-blank / unmapped flag) · **Integrity** column with the gap chips. Per-scope subtotals
  (from `AssuranceTrendYear.byScope`) + `All scopes total`. Flagged category rows get a coloured left edge.
- **Tabs** — By scope (category amalgamation, baseline vs current); By site (current year, **Unallocated**
  rows flagged as a completeness signal); Audit table (per enabled row: category, factor, qty+unit, quality,
  confidence, site, review — unmapped rows flagged); Intensity (`total ÷ reporting denominator` across the
  trend, or a "no intensity target" note).
- **CSV export** of the trend.
- **Five explicit UI states** — loading · **failed** (an `alert` + Retry, *never* a table of zeros) ·
  degraded · success. A 503 from `/assurance` renders the failed state, not a zeroed report.

## Gate (DA3a)

| # | Item | Check |
|---|---|---|
| 1 | Trend renders **baseline column with BL pill (always present)** + priors + current; **`% vs BL`** is its own column, computed vs baseline (not prior year) | `data-assurance.spec.ts` |
| 2 | `% vs BL` tone is neutral grey when driven by an unresolved non-YoY flag; normal otherwise | `packages/contracts/tests/dataAssurance.test.ts` (`percentVsBaselineTone`) |
| 3 | `getAssuranceScreen` composes trend + gap engine (4 flags) + audit rows; non-CRP → null | `packages/isolated-backend/tests/assuranceScreen.test.ts` |
| 4 | Tabs switch views; By site flags **Unallocated**; Audit flags unmapped rows | e2e |
| 5 | A failed `/assurance` read → `alert` + Retry, **no `table.nz-assurance-trend`** | e2e |
| 6 | No uncatalogued serious/critical axe violations; no horizontal **page** overflow at 390 / 768 / 1280 / 1920 (the wide table scrolls inside its own panel) | `scanWithBaseline(page, "data-assurance")` + `expectNoHorizontalOverflow` |
| 7 | **Flag hard-precondition** — once the surface is present, every check is hard (fail loud, no silent skip). The one conditional skip (flag not yet live) is removed in the flip PR. | `data-assurance.spec.ts` `openAssurance` |
| 8 | `npm run typecheck` · `@nzi/console` build · full unit suites green · **flag OFF leaves Review & QA unchanged** | ✅ |
| 9 | **Human-only:** screen-reader on the tabs + trend table + banner; reduced-motion; the BL / current tint reads as AA | ⏳ Francis |

## Verification (DA3a, this PR)

- `npm run typecheck` — clean · `npm run build -w @nzi/console` — green (routes registered).
- `@nzi/contracts` 69/69 · `@nzi/isolated-backend` 234/234 (+2 `getAssuranceScreen`) · console 85/85 ·
  portal 89/89 · staff 33/33.
- `data-assurance.spec.ts` (3) — skips until `data-assurance` is live; **harden at flip**.

## Flip (DA3a)

Append `data-assurance` to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` in the Render dashboard + rebuild; add to
`render.yaml`. Harden `data-assurance.spec.ts` (remove the flag skip), run against deployed staging, record
here + the human pass in `docs/STAGING_ACCEPTANCE_DA3.md`.

## Rollback

Presentational, additive. Remove `data-assurance` + rebuild — Review & QA renders as before. No data / route
/ schema change (DA1's `0052` is already in place and unread without this surface).
