// R1/R5a/R5b — the paged-media rules shared between the real print/PDF path
// (wrapped in `@media print` for the browser's own print engine) and the
// Paged.js in-app "Page view · A4" preview (which IS a paged-media context —
// no `@media` wrapper needed there). One rule set, so the on-screen page map
// and the generated PDF are built from the same CSS fragmentation contract,
// not two: repeating audit-table headers, row-atomic breaks, an appendix
// always starting a fresh page, chart/section atomicity, and which
// screen-only chrome (integrity banner, source pills, the "header repeats…"
// annotation) is presentation-only and never printed/previewed.
export const REPORT_PAGED_MEDIA_RULES = `html,body{background:white!important}.report-canvas{background:white!important;padding:0!important}.report-toolbar{display:none!important}.report-sheet{border:0!important;border-radius:0!important;box-shadow:none!important;max-width:none!important;margin:0!important;padding:0!important}figure,[data-chart]{break-inside:avoid;page-break-inside:avoid}.nz-report-section{break-inside:avoid}.nzc-print-safe,.nz-report-integrity,.nz-section-source,.report-thead-note,.report-view-toggle{display:none!important}.nz-fig-token{background:none!important;border:0!important;padding:0!important;color:inherit!important;font-weight:inherit!important}.report-appendix{break-before:page}.report-appendix-scroll{overflow:visible!important}.report-audit-table thead{display:table-header-group}.report-audit-table tr{break-inside:avoid;page-break-inside:avoid}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}`;

/** CSS-escape a value embedded in an `@page` `content: "…"` string. */
export function escapeCssContent(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type ReportPagedMeta = { client: string; jobNumber: string; reportingYear: number };

/**
 * R5b — the Paged.js stylesheet: A4 size/margin, a running header/footer via
 * CSS Generated Content for Paged Media (`@top-center`/`@bottom-*`, suppressed
 * on the cover via `@page :first`), plus the same `REPORT_PAGED_MEDIA_RULES`
 * the real print path uses. Static content (not `string-set`) is correct here
 * — this report has one "chapter", so the header/footer never varies by page.
 */
export function buildReportPagedCss(meta: ReportPagedMeta): string {
  const client = escapeCssContent(meta.client);
  const jobNumber = escapeCssContent(meta.jobNumber);
  return `@page{size:A4;margin:14mm 12mm}
@page{@top-center{content:"${client} · Carbon Reduction Plan · ${meta.reportingYear}";font-size:9.5px;color:#51605A}@bottom-left{content:"Net Zero International";font-size:9.5px;color:#51605A}@bottom-right{content:"${jobNumber} · Page " counter(page) " of " counter(pages);font-size:9.5px;color:#51605A}}
@page :first{@top-center{content:none}@bottom-left{content:none}@bottom-right{content:none}}
${REPORT_PAGED_MEDIA_RULES}
.pagedjs_pages{padding:22px 0;display:flex;flex-direction:column;align-items:center}
.pagedjs_page{background:#fff;box-shadow:0 8px 30px rgba(11,27,43,.12);margin:0 auto 22px}`;
}
