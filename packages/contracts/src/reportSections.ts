// R2 — editable report sections (NZC-048). A CRP report is an ordered list of
// versioned narrative sections. Each section's *default* wording is the NZI
// template, held here in code (like the chart manifest), so a working row in
// `report_sections` exists only once a section has been edited or reset. The
// figures inside the prose stay generic in R2 — R3 replaces them with data-bound
// tokens resolved from the reviewed snapshot.

export type ReportSectionContentSource = "default" | "ai" | "client-edited";

export type ReportSectionTemplate = {
  key: string;
  title: string;
  /** Position in the report narrative; ascending, gap-tolerant. */
  ordinal: number;
  /** NZI standard wording. Plain sanitised HTML — <p>, <ul>/<li>, <strong>, <em>. */
  defaultBodyHtml: string;
  /**
   * R4 — the "Regenerate (AI)" redraft of this section. Deterministic
   * alternate wording drawing on the same figure-token palette as the default,
   * so an AI draft is data-bound by construction. (A live model call is a
   * follow-up — this keeps the `ai` content source real without an LLM dependency.)
   */
  aiBodyHtml: string;
};

/** R4 — the working-sections editor screen for a job's Report & publish stage. */
export type ReportSectionEditorScreen = {
  jobId: string;
  jobNumber: string;
  reportingYear: number;
  sections: ReportSectionReadModel[];
  /** Live (unreviewed) job figures for resolving token previews in the editor. */
  figures: {
    reportingYear: number;
    measurements: Array<{ scope: "1" | "2" | "3"; tco2e: number }>;
    target: { baselineYear: number; baselineTco2e: number; interimYear: number; interimReductionPercent: number; netZeroYear: number } | null;
    intensityTarget: { denominatorUnit: string; reportingDenominator: number | null } | null;
  };
};

/** One resolved section as the report + snapshot read models carry it. */
export type ReportSectionReadModel = {
  key: string;
  title: string;
  ordinal: number;
  contentSource: ReportSectionContentSource;
  bodyHtml: string;
  /** 0 when the section is still the untouched template (no working row). */
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

// `<span data-token="KEY"></span>` markers are resolved to locked figure chips at
// render time (R3 / NZC-049, @nzi/contracts renderReportSectionBody).
export const crpReportSectionCatalogue: readonly ReportSectionTemplate[] = [
  // B2-4 (RULING-report-studio-B2-4 (c)): each default is composed@5's own wording — the template the report draws — so "Reset"
  // returns exactly what the report shows. Every figure is a token; where composed@5 says a clause only when the data holds it
  // (a baseline, sites, a net zero target), a phrase token carries the clause and resolves to nothing otherwise. No typed digit
  // outside a token but the published allowlist ("Scope 1/2/3") — `reportNarrativeBodyIssues` holds every body to that.
  {
    key: "executive-summary",
    title: "Executive summary",
    ordinal: 10,
    defaultBodyHtml:
      "<p><span data-token=\"client\"></span> recorded total greenhouse gas emissions of <span data-token=\"total\"></span> for the <span data-token=\"reportingYear\"></span> reporting year, comprising <span data-token=\"scope1\"></span> from Scope 1, <span data-token=\"scope2\"></span> from Scope 2 and <span data-token=\"scope3\"></span> from Scope 3, prepared under the GHG Protocol Corporate Standard on an operational control boundary.</p>" +
      "<p>Scope 3 value-chain activity represents <span data-token=\"scope3Pct\"></span> of total emissions. This report sets out the reduction pathway to net zero and the prioritised carbon reduction actions, and records the reviewed evidence from which every figure is derived.</p>",
    aiBodyHtml:
      "<p>In the <span data-token=\"reportingYear\"></span> reporting year <span data-token=\"client\"></span> measured emissions of <span data-token=\"total\"></span>: <span data-token=\"scope1\"></span> direct (Scope 1), <span data-token=\"scope2\"></span> from purchased energy (Scope 2) and <span data-token=\"scope3\"></span> across the value chain (Scope 3).</p>" +
      "<p>With the value chain at <span data-token=\"scope3Pct\"></span> of the total, the reduction plan concentrates on suppliers and purchased goods alongside the organisation's own operations. Every figure in this report is drawn from the reviewed evidence.</p>",
  },
  {
    key: "net-zero-commitment",
    title: "Net zero commitment",
    ordinal: 20,
    defaultBodyHtml:
      "<p><span data-token=\"client\"></span> is committed to achieving net zero greenhouse gas emissions across all scopes by <span data-token=\"netZeroYear\"></span>, supported by a credible, evidence-led reduction pathway<span data-token=\"baselineAnchor\"></span>.</p>",
    aiBodyHtml:
      "<p><span data-token=\"client\"></span> has set a clear ambition: net zero across every scope by <span data-token=\"netZeroYear\"></span>, on an evidence-led reduction pathway<span data-token=\"baselineAnchor\"></span>.</p>",
  },
  {
    key: "background",
    title: "Background & organisation",
    ordinal: 30,
    defaultBodyHtml:
      "<p><span data-token=\"client\"></span> reports its greenhouse gas emissions for the <span data-token=\"reportingYear\"></span> reporting year under the operational control approach<span data-token=\"siteClause\"></span>.</p>" +
      "<p>Boundary and methodology decisions are recorded in the standards and methodology section and in the assurance record.</p>",
    aiBodyHtml:
      "<p>This report covers <span data-token=\"client\"></span>'s greenhouse gas emissions for the <span data-token=\"reportingYear\"></span> reporting year, consolidated under the operational control approach<span data-token=\"siteClause\"></span>.</p>" +
      "<p>The standards and methodology section sets out the boundary and the methods applied.</p>",
  },
  {
    key: "intensity-analysis",
    title: "Intensity metric analysis",
    ordinal: 40,
    defaultBodyHtml:
      "<p>Intensity metrics normalise emissions against business activity so performance can be compared year on year regardless of changes in scale. <span data-token=\"client\"></span> reports <span data-token=\"intensityMeasures\"></span>.</p>",
    aiBodyHtml:
      "<p>Normalising emissions to business activity shows performance independent of growth or contraction. <span data-token=\"client\"></span> reports <span data-token=\"intensityMeasures\"></span>.</p>",
  },
  {
    key: "category-analysis",
    title: "Emissions by scope & category",
    ordinal: 50,
    defaultBodyHtml:
      "<p>For the <span data-token=\"reportingYear\"></span> reporting year total measured carbon emissions are <span data-token=\"total\"></span>. <span data-token=\"largestScope\"></span> is the largest share at <span data-token=\"largestTotal\"></span> (<span data-token=\"largestPct\"></span>), followed by <span data-token=\"secondScope\"></span> at <span data-token=\"secondTotal\"></span> and <span data-token=\"thirdScope\"></span> at <span data-token=\"thirdTotal\"></span>.</p>" +
      "<p>The largest categories are the focus of the reduction actions.</p>",
    aiBodyHtml:
      "<p>The <span data-token=\"reportingYear\"></span> profile totals <span data-token=\"total\"></span>, led by <span data-token=\"largestScope\"></span> at <span data-token=\"largestTotal\"></span> (<span data-token=\"largestPct\"></span>).</p>" +
      "<p>The reduction actions target the categories that drive the largest share.</p>",
  },
  {
    key: "reduction-actions",
    title: "Carbon reduction actions",
    ordinal: 60,
    defaultBodyHtml:
      "<p><span data-token=\"client\"></span> has identified <span data-token=\"actionCount\"></span> carbon reduction action<span data-token=\"actionsPlural\"></span>, grouped by how much of each the client controls<span data-token=\"actionsTarget\"></span>.</p>" +
      "<p><span data-token=\"progressReview\"></span></p>",
    aiBodyHtml:
      "<p>The plan sets out <span data-token=\"actionCount\"></span> carbon reduction action<span data-token=\"actionsPlural\"></span>, each owned, scheduled and grouped by how much of it the client controls<span data-token=\"actionsTarget\"></span>.</p>" +
      "<p><span data-token=\"progressReview\"></span></p>",
  },
] as const;

const catalogueByKey = new Map(crpReportSectionCatalogue.map((section) => [section.key, section]));

export function crpReportSectionTemplate(key: string): ReportSectionTemplate | undefined {
  return catalogueByKey.get(key);
}

export function isCrpReportSectionKey(key: string): boolean {
  return catalogueByKey.has(key);
}

/**
 * Merge the template catalogue with whatever working rows exist, in report
 * order. A section with no working row resolves to its template at version 0.
 */
export function resolveReportSections(
  working: ReadonlyArray<Pick<ReportSectionReadModel, "key" | "contentSource" | "bodyHtml" | "version" | "updatedBy" | "updatedAt">>,
): ReportSectionReadModel[] {
  const byKey = new Map(working.map((row) => [row.key, row]));
  return [...crpReportSectionCatalogue]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((template) => {
      const row = byKey.get(template.key);
      return {
        key: template.key,
        title: template.title,
        ordinal: template.ordinal,
        contentSource: row?.contentSource ?? "default",
        bodyHtml: row?.bodyHtml ?? template.defaultBodyHtml,
        version: row?.version ?? 0,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
}
