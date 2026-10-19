// DESIGN-report-studio-small-fixes D + E: the Report Studio's print / Save-as-PDF and its "Page · A4" view, for the composed@5
// document it draws. One rule set for both engines — Paged.js for the on-page A4 preview, the browser's own print engine for the
// PDF — so the preview is the PDF (the R1/R5b discipline of `reportPrintRules.ts`, applied to composed@5).
//
// Studio-only on purpose. The issued report's print path (`reportPrintRules.ts`, composed@5's own `@media print`) and every
// composed@1–5 renderer are untouched: nothing here is imported by them, and the document's markup is not changed — these rules
// style it from outside, and only on the studio page.
//
// E — atomicity on rows, figures and charts, never on a whole section. A composed@5 section is one `.r5-page`; drawn as one fixed
// A4 sheet, a section taller than a page (Sites & reporting boundary, the Full emissions audit) overran it. Here each section
// starts a page and then flows onto as many as it needs: a chart card, a key-value box, the cover's metacard and each table row
// stay whole; a table's header repeats on every page it continues onto; a heading never ends a page.

/** What a printed page says it is — so a draft PDF can never be taken for the issued document. Published: nothing. */
export function studioPrintMark(kind: "draft" | "validated" | "published"): string | null {
  return kind === "draft" ? "DRAFT — not validated, not issued" : kind === "validated" ? "PREVIEW — validated, not issued" : null;
}

/** CSS-escape a value embedded in an `@page` `content: "…"` string. */
const cssString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** The fragmentation and chrome rules, shared by the Paged.js preview and the print engine. */
export const STUDIO_R5_PAGED_RULES = [
  ".nzr5{background:none!important;padding:0!important}",
  ".nzr5 .r5-pageflow{display:block!important}",
  // The screen's simulated sheet furniture: the per-section running head and foot (replaced by the page's own margin boxes, which
  // number real pages), and Continuous view's break markers.
  ".nzr5 .r5-pbreak,.nzr5 .r5-runhead,.nzr5 .r5-runfoot{display:none!important}",
  // Each section starts a page and flows — no min-height, no fixed sheet, no break-inside on the section.
  // break-after:auto overrides composed@5's own print rule (break-after:page on every sheet), which left a blank last page.
  ".nzr5 .r5-page{width:auto!important;max-width:none!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;box-shadow:none!important;will-change:auto!important;break-before:page;break-after:auto!important;break-inside:auto}",
  ".nzr5 .r5-pageflow>.r5-page:first-child{break-before:auto}",
  // Atomic: a chart, a figure, a key-value box, the cover's metacard, a callout — and every table row.
  ".nzr5 .r5-chartcard,.nzr5 figure,.nzr5 [data-chart],.nzr5 svg,.nzr5 .r5-kvbox,.nzr5 .r5-metacard{break-inside:avoid;page-break-inside:avoid}",
  ".nzr5 table tr{break-inside:avoid;page-break-inside:avoid}",
  ".nzr5 table thead{display:table-header-group}",
  ".nzr5 .r5-h2,.nzr5 .r5-kicker,.nzr5 h3{break-after:avoid}",
  // Screen-only provenance chrome, stripped as `reportPrintRules.ts` strips source pills: the template pill, the header note, and
  // the figure-token chip (the figure stays; its lock styling does not).
  ".nzr5 .r5-spill,.nzr5 .r5-thead-note{display:none!important}",
  ".nzr5 .r5-tok{background:none!important;border:0!important;padding:0!important;color:inherit!important}",
  ".nzr5 .r5-tok::before{display:none!important}",
  "*{-webkit-print-color-adjust:exact;print-color-adjust:exact}",
].join("");

export type StudioPrintMeta = { client: string; title: string; mark: string | null };

/** The `@page` box: A4, the running head and foot as margin boxes (real page numbers), the draft mark on every page. */
function pageRules(meta: StudioPrintMeta): string {
  const mark = meta.mark ? `@top-right{content:${cssString(meta.mark)};font-size:9px;font-weight:700;color:#B4261A;letter-spacing:.04em}` : "";
  return `@page{size:A4;margin:16mm 15mm}`
    + `@page{@top-left{content:${cssString(`${meta.client} · ${meta.title}`)};font-size:9px;color:#51605A}${mark}`
    + `@bottom-left{content:"Private & Confidential";font-size:9px;color:#51605A}`
    + `@bottom-right{content:"Page " counter(page) " of " counter(pages);font-size:9px;color:#51605A}}`
    // The cover carries no running head or foot — but a draft's mark stays on it too.
    + `@page :first{@top-left{content:none}@bottom-left{content:none}@bottom-right{content:none}}`;
}

/** Paged.js's stylesheet for the on-page "Page · A4" view. */
export function buildStudioPagedCss(meta: StudioPrintMeta): string {
  return `${pageRules(meta)}${STUDIO_R5_PAGED_RULES}`
    + `.pagedjs_pages{padding:22px 0;display:flex;flex-direction:column;align-items:center}`
    + `.pagedjs_page{background:#fff;box-shadow:0 8px 30px rgba(11,27,43,.12);margin:0 auto 22px}`;
}

/**
 * The studio page's print stylesheet: the same rules under `@media print`, over the flow document — whichever view is on screen,
 * the PDF is built from the document itself, never from the preview's already-paginated copy (which would paginate twice).
 */
export function buildStudioPrintCss(meta: StudioPrintMeta): string {
  return `${pageRules(meta)}@media print{${STUDIO_R5_PAGED_RULES}`
    + `.nzs-paged{display:none!important}.nzs-paged-source{display:block!important}`
    // The console around the studio (rail, top bar, breadcrumbs, the studio's sub-pages) is not the document; nor is the
    // on-screen draft band — every page carries the mark instead, so page one is the same in the PDF as in Page · A4.
    + `.nz-rail,.nz-topbar,.nz-skip-link,.nzs-subnav,[data-report-draft],[data-report-preview]{display:none!important}`
    + `.nz-app,.nz-main,.nz-preview-canvas{display:block!important;padding:0!important;margin:0!important;background:none!important}`
    + `.nzs-stage{background:none!important;padding:0!important}}`;
}
