# R5 — paged output: repeating headers + on-screen page breaks · acceptance

Spec: `docs/REPORT_PRINTING_UX.md` §4 + §6. Decision **NZC-051**. Fifth and final proposed Report Studio
slice; sits on R1 (print-safe charts) and the reviewed-snapshot mechanism every prior slice already reuses.
**Flag:** `report-paged` in `NEXT_PUBLIC_FEATURE_REPORT_STUDIO`.

Sliced so the part with no design ambiguity lands first:

| Slice | Scope | Status |
|---|---|---|
| **R5a** | Audit appendices (Appendix 1 Full Emissions Audit, Appendix 2 by Site/Scope/Category) + the repeating-header / row-atomic print CSS that makes them paginate cleanly. | 🟢 built (PR #90) |
| R5b | On-screen Continuous / Page view · A4 toggle, running header/footer, dashed page-break markers. | ⏳ proposed — pagination-computation approach needs confirming before deep build |

## R5a — the audit appendices

Fixes root problem 3 ("tables spill past a page and lose their header row") for the two long tables the
spec names. Both read straight off the **frozen reviewed snapshot's `measurements`** — the exact same
array the rest of `/reports/[versionId]` already reads for the cover metrics and charts — so there is
**no new backend, no migration, no command**.

- **`packages/contracts/src/reportAppendix.ts`** (new, pure) —
  - `buildReportAuditRows(measurements)`: Appendix 1, one row per enabled measurement (category via the
    existing `crpScopeCategoryLabel`, activity/source, quantity+unit, factor set, quality tier, site,
    tCO2e), sorted scope → category → source.
  - `buildReportSiteBreakdown(measurements)`: Appendix 2, grouped site → scope → category, each level
    totalled. "Unallocated" is a real site (measurements with no site are never dropped), matching the
    "empty ≠ missing" principle used everywhere else in the app.
- **`apps/console/app/reports/[versionId]/page.tsx`** — `ReportAppendices`, rendered only when
  `reportFeatureEnabled("report-paged")`; flag off is byte-identical to before. Uses the frozen
  `snapshot.measurements` already loaded for the page — no new fetch.
- **Print CSS** (the page's own `PRINT_CSS` `<style>` tag, extended): `.report-audit-table
  thead{display:table-header-group}` (the header **repeats on every printed page** the table spans —
  standards-compliant CSS Fragmentation, correctly honoured by Chromium's print/Save-as-PDF engine, which is
  the "server-side Chromium print" the spec names — no extra library needed for this half of the paged-
  output problem); `.report-audit-table tr{break-inside:avoid}` (a row is never split across a page);
  `.report-appendix{break-before:page}` (each appendix starts on its own page). The on-screen
  `.report-thead-note` annotation ("header repeats on every printed page") is print-hidden — a screen-only
  design affordance, not report content.

## Gate (R5a)

| # | Item | Check |
|---|---|---|
| 1 | Appendix 1 renders one row per enabled measurement; Appendix 2 groups site → scope → category with per-level totals; both are a pure re-shape of the frozen snapshot (same tCO2e total survives) | `reportAppendix.test.ts` |
| 2 | Unallocated is a real, visible site — never dropped | `reportAppendix.test.ts` |
| 3 | No scope with zero categories is invented in Appendix 2 | `reportAppendix.test.ts` |
| 4 | Print CSS gives the audit table a repeating `<thead>` and row-atomic breaks; each appendix starts on a fresh printed page | `report-appendix.spec.ts` (asserts the literal CSS rules — a real paginated PDF is a human check) |
| 5 | Flag OFF renders `/reports/[versionId]` exactly as before (no `.report-appendix`, no new fetch) | code review — single flag-gated block, no other change |
| 6 | No uncatalogued serious/critical axe violations; no horizontal overflow with the appendix present | `scanWithBaseline(page, "report-appendix")` + `expectNoHorizontalOverflow` |
| 7 | **Flag hard-precondition** — once `.report-appendix` is present, every check is hard. The one conditional skip (flag not yet live) is removed at the flip PR. | `report-appendix.spec.ts` |
| 8 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification (R5a)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green.
- `@nzi/contracts` — 74/74 (+5 `reportAppendix.test.ts`).
- `report-appendix.spec.ts` (3) — skips until `report-paged` is live; **harden at flip**.

## R5b — the on-screen view toggle (proposed, not yet built)

The spec's harder half: "Continuous — a dashed 'Page N break' marker at every page boundary" and "Page
view · A4 — content laid into true A4 page frames with running header/page numbers", with the on-screen
page map required to **match the generated PDF exactly**. The reference prototype (`report_v3.html`)
**hand-authors** its page split (a fixed `PAGES` array of pre-written chunks) precisely because true
pagination — deciding exactly where content breaks across A4 pages — is the one genuinely open design
question here, the R5 equivalent of DA1's baseline-model question. Two real approaches, with different
cost/fidelity trade-offs:

- **(a) Measure-and-bucket (no new dependency).** After the report mounts, walk its top-level blocks
  (headings, paragraphs, table row-groups, chart figures), measure each one's rendered height, and
  greedily bucket them into page-sized groups against a computed A4 content-area height (derived from the
  page's own `14mm` margins). Cheap, no library, but it's an *approximation* of the browser's own print
  layout engine — for most content it will agree with the printed PDF, but a table row split right at a
  page edge, or the print engine's own widow/orphan handling, can disagree by a line here or there.
- **(b) A real paged-media engine (Paged.js).** Paged.js literally implements the CSS Fragmentation spec
  client-side and produces the same break points a compliant paged-media renderer would use, so the
  on-screen map and the printed PDF agree far more reliably — at the cost of a new external dependency (it
  would need to load from `cdnjs.cloudflare.com`, the one allowed source for this kind of library) and a
  heavier, more involved integration (it takes over layout of the content it's given).

**Proposing (a) as the default** — no new dependency, ships faster, and is honest about being an on-screen
*preview* (the actual PDF pagination already comes from the browser's print engine + the R5a CSS, which is
authoritative regardless of what the preview shows) — but this is genuinely a build vs. buy / cost vs.
fidelity call, not something to guess silently on. **Holding R5b until this is confirmed**, same as the
DA1 baseline-model and DA3c gate-composition pattern.

## Flip (R5a)

Append `report-paged` to `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` in the Render dashboard + rebuild; add to
`render.yaml`. Harden `report-appendix.spec.ts` (remove the flag skip), run against deployed staging,
record here + a human pass (print/Save-as-PDF an actual multi-page audit table on a job with enough rows
and confirm the header genuinely repeats and no row is cut in half — the one check this spec cannot do
itself).

## Rollback

Presentational + print-CSS only, additive. Remove `report-paged` + rebuild — the report renders exactly as
before. No data / route / schema change.
