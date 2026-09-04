# R5 — paged output: repeating headers + on-screen page breaks · acceptance

Spec: `docs/REPORT_PRINTING_UX.md` §4 + §6. Decision **NZC-051**. Fifth and final proposed Report Studio
slice; sits on R1 (print-safe charts) and the reviewed-snapshot mechanism every prior slice already reuses.
**Flag:** `report-paged` in `NEXT_PUBLIC_FEATURE_REPORT_STUDIO`.

Sliced so the part with no design ambiguity lands first:

| Slice | Scope | Status |
|---|---|---|
| **R5a** | Audit appendices (Appendix 1 Full Emissions Audit, Appendix 2 by Site/Scope/Category) + the repeating-header / row-atomic print CSS that makes them paginate cleanly. | 🟢 built (PR #90) |
| **R5b** | On-screen Continuous / Page view · A4 toggle, running header/footer, page numbers, dashed page-break markers. | 🟢 built (PR #91) — Paged.js, confirmed by Francis 4 Sep 2026 |

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

## R5b — the on-screen view toggle

**Decision (Francis, 4 Sep 2026): Paged.js**, for consistency with R5a — it applies the exact same CSS
fragmentation rules (repeating `<thead>`, `break-inside:avoid`, running header/footer) that R5a's print
CSS and the server/browser's own Chromium print engine already use, so Page view agrees with the PDF.
Measure-and-bucket would ignore that CSS and drift (splitting tables mid-row, dropping repeating headers),
defeating the feature. **The server/browser print path stays the authoritative source of truth** — Page
view is a high-fidelity *preview* of it, not a byte-identity guarantee.

- **`pagedjs@0.4.3`** added to `apps/console` (npm dependency, not a CDN script — this is a real app
  bundle, not an Artifact). No new CVE: `npm audit` shows the same 3 pre-existing high-severity findings
  (transitive to `next` itself, via `postcss`/`sharp`) before and after the install; none of pagedjs's own
  five dependencies appear. No bundled types / no `@types/pagedjs` — a minimal ambient declaration
  (`apps/console/app/types/pagedjs.d.ts`) covers the one class used (`Previewer`). **Imported via the bare
  `"pagedjs"` specifier** — the package's own `exports` map has no `./dist/*` subpath, so a deep import
  (tried first) fails a strict-`exports` resolution; the bare specifier resolves to its ES module source,
  which webpack bundles and code-splits normally.
- **Lazy-loaded** (guardrail): `await import("pagedjs")` runs only inside the effect that fires when the
  user switches to **Page view · A4** — verified in the production build: `/reports/[versionId]`'s own
  route chunk stayed at **2.33 kB / 105 kB first load** (unchanged from before pagedjs was added); pagedjs
  itself resolved into its own **~300 kB (minified) chunk**, confirmed present in `.next/static/chunks`
  under its own numbered filename, not inlined into the route.
- **`apps/console/app/reports/[versionId]/reportPrintRules.ts`** — `REPORT_PAGED_MEDIA_RULES` (the shared
  fragmentation rules, now a named export `PRINT_CSS` wraps in `@media print` and `buildReportPagedCss`
  reuses verbatim, unwrapped — Paged.js's rendering context already *is* paged media, no `@media` needed)
  + `buildReportPagedCss(meta)`: `@page{size:A4;margin:14mm 12mm}`, a running header/footer via **CSS
  Generated Content for Paged Media** (`@top-center`/`@bottom-left`/`@bottom-right`, static text — this
  report has one "chapter" so content never varies by page — with `counter(page)`/`counter(pages)` for
  page numbers), suppressed on the cover via `@page :first{...content:none}`. Values are CSS-escaped
  (`escapeCssContent`) before being embedded in a `content: "…"` string.
- **`apps/console/app/reports/[versionId]/ReportPagedView.tsx`** — the toggle (`.report-view-toggle`,
  Continuous default). On switching to Page view: clones `.report-sheet` (stripping the `.pbreak` markers),
  dynamically imports `pagedjs`, and calls `previewer.preview(html, [{href: cssText}], target)` — the
  object form of the stylesheet argument, so the CSS is handed to Paged.js directly with no fetch/Blob URL
  needed. Five explicit states: idle → loading (a status banner) → ready (`.pagedjs_page` elements visible)
  or **failed** (an alert banner, Continuous view and the real Print/Save-as-PDF path unaffected — a
  pagination bug in the preview must never look like the report itself is broken). The Continuous view's
  DOM is `hidden`, not unmounted, when Page view is active, and vice versa.
- **`apps/console/app/reports/[versionId]/reportPageBreaks.ts`** (pure, unit-tested) —
  `computePageBreakIndices`: Continuous view's own lightweight "Page N break" markers (guardrail: kept
  cheap here — advisory editing guides, not a fidelity claim). Greedy first-fit over each top-level block's
  measured height against the A4 content-area height; a single block taller than a page is never split
  around, it just overflows onto the next page on its own.

## Gate (R5b)

| # | Item | Check |
|---|---|---|
| 1 | pagedjs is lazy-loaded — the report route's bundle size is unchanged from before the dependency was added; pagedjs resolves to its own separate chunk | verified in the production build (route stayed 2.33 kB / 105 kB; a ~300 kB chunk appears separately in `.next/static/chunks`) |
| 2 | No new CVE from the dependency | `npm audit` diffed before/after — identical 3 pre-existing findings, none in pagedjs's own deps |
| 3 | Page view uses the *same* paged-media rules (`REPORT_PAGED_MEDIA_RULES`) as the real print path — one fragmentation contract | `reportPageBreaks.test.ts` (`buildReportPagedCss` contains `REPORT_PAGED_MEDIA_RULES` verbatim) |
| 4 | Running header/footer + page numbers render, suppressed on the cover only | `report-paged-view.spec.ts` (asserts `.pagedjs_margin-*-content` text per page) |
| 5 | Continuous view's break markers are a pure, greedy first-fit; a too-tall block is never split around | `reportPageBreaks.test.ts` |
| 6 | A Paged.js failure shows an alert, never a blank container — Continuous view and Print/Save-as-PDF stay unaffected | `ReportPagedView.tsx` (`pageState:"failed"`) — forcing an actual pagedjs failure is a human check |
| 7 | Flag OFF renders `/reports/[versionId]` exactly as before (no toggle, no pagedjs reference at all) | code review — single flag-gated wrap around the existing article |
| 8 | No uncatalogued serious/critical axe violations; no horizontal overflow with the toggle present | `scanWithBaseline(page, "report-paged-view")` + `expectNoHorizontalOverflow` |
| 9 | **Flag hard-precondition** — once `.report-view-toggle` is present, every check is hard. The one conditional skip (flag not yet live) is removed at the flip PR. | `report-paged-view.spec.ts` |
| 10 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification (R5a: PR #90, R5b: PR #91)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green; report route
  bundle unchanged, pagedjs confirmed split into its own chunk.
- `@nzi/contracts` — 74/74 · `@nzi/console` unit suite — 99/99 (+10 `reportPageBreaks.test.ts`).
- `report-appendix.spec.ts` (3) + `report-paged-view.spec.ts` (5) — skip until `report-paged` is live;
  **harden both at flip**.

## Human check (required before flip — cannot be automated)

Render **First Event's** multi-page audit (the seed CRP job with enough rows to span several A4 pages)
both ways — **Page view · A4** in-app, and the actual **Print/Save-as-PDF** output — and confirm the two
page maps agree: same page count, the audit table's header genuinely repeats at the same rows, no row cut
in half, the running header/footer text and page numbers match. **If they diverge materially, that is a
signal to chase (a Paged.js/browser fragmentation mismatch worth understanding), not something to paper
over or wave through.** Record the outcome here.

## Flip

Append `report-paged` to `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` in the Render dashboard + rebuild; add to
`render.yaml`. Harden `report-appendix.spec.ts` + `report-paged-view.spec.ts` (remove the flag skips), run
against deployed staging, complete the human check above, record both here + in
`docs/STAGING_ACCEPTANCE_R5.md`.

## Rollback

Presentational + print-CSS only, additive. Remove `report-paged` + rebuild — the report renders exactly as
before, pagedjs is never fetched. No data / route / schema change. The `pagedjs` npm dependency can stay in
`package.json` even with the flag off (it costs nothing unloaded); removing it entirely is a separate,
optional cleanup if the slice is ever reverted for good.
