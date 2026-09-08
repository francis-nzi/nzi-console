# R5 — staging acceptance record

Date: **8 September 2026**  
Target: isolated Render staging (`https://nzi-pro-api-prod.onrender.com`)  
Flag: `NEXT_PUBLIC_FEATURE_REPORT_STUDIO=report-svg-charts,report-tokens,report-edit,report-paged`  
Live revision: `301864a` (PR #128)

## Automated result

- Both R5 specs now treat the deployed appendix and Continuous/A4 toggle as hard preconditions.
- Playwright: **10/10 passed** — two authentication setup checks, all three R5a appendix journeys,
  and all five R5b page-view journeys.
- Both appendices rendered from the frozen snapshot; repeating table headers, row-atomic breaks,
  appendix page starts, `data-report-ready`, axe and horizontal-overflow checks passed.
- Continuous remained the default; Page view built multiple A4 pages; cover margins were suppressed;
  later-page running header/footer rules were applied; switching back restored the report.
- Workspace typecheck and `@nzi/console` **127/127** passed before deployment.

## Staging findings closed

1. Paged.js cannot measure generated pages inside a `display:none` target. PR #127 keeps its target
   measurable while pagination runs and hides it only while idle/failed.
2. The shared paged-media CSS was injected globally by Paged.js and hid the outer view toggle. PR #128
   confines that rule to real print, preserving the interactive toggle in the preview.
3. CSS generated content does not become DOM `textContent`; the footer gate now inspects its applied
   `::after` content and page metadata instead of asserting nonexistent text nodes.

## Human gate

Still open for Francis: open the seeded multi-page report in **Page view · A4**, then use
**Print / Save as PDF** for that same version and compare page breaks, repeating table headers,
cover suppression, running headers and page numbers page-by-page. Also check Narrator and reduced motion.
