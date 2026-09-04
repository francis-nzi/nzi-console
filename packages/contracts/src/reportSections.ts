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

export const crpReportSectionCatalogue: readonly ReportSectionTemplate[] = [
  {
    key: "executive-summary",
    title: "Executive summary",
    ordinal: 10,
    defaultBodyHtml:
      "<p>This report presents the organisation's measured greenhouse gas emissions for the reporting period, prepared in accordance with the GHG Protocol Corporate Accounting and Reporting Standard. Emissions are reported across Scope 1, Scope 2 and the material Scope 3 categories, under the operational control boundary.</p>" +
      "<p>The report establishes the reduction pathway to net zero, sets out the prioritised carbon reduction actions, and records the reviewed evidence from which every figure in this document is derived.</p>",
  },
  {
    key: "net-zero-commitment",
    title: "Net zero commitment",
    ordinal: 20,
    defaultBodyHtml:
      "<p>The organisation is committed to achieving net zero greenhouse gas emissions across all scopes, supported by a credible, evidence-led reduction pathway with an interim milestone ahead of the net zero target year.</p>" +
      "<ul><li>Achieve the reduction targets set out in this plan.</li><li>Set realistic short- and long-term targets consistent with the net zero commitment.</li><li>Report total greenhouse gas emissions at least annually.</li></ul>",
  },
  {
    key: "background",
    title: "Background & organisation",
    ordinal: 30,
    defaultBodyHtml:
      "<p>This section describes the reporting organisation, the nature of its operations and the organisational boundary applied to this assessment. Emissions are consolidated using the operational control approach unless stated otherwise.</p>" +
      "<p>The reporting period, methodology and boundary decisions are recorded in the standards and methodology section and in the assurance record.</p>",
  },
  {
    key: "intensity-analysis",
    title: "Intensity metric analysis",
    ordinal: 40,
    defaultBodyHtml:
      "<p>Intensity metrics normalise emissions against a measure of business activity so that performance can be compared year on year regardless of changes in the scale of operations.</p>" +
      "<p>This report expresses intensity against the reporting denominator recorded for the period, and projects it forward on the same pathway as absolute emissions.</p>",
  },
  {
    key: "category-analysis",
    title: "Emissions by scope & category",
    ordinal: 50,
    defaultBodyHtml:
      "<p>This section analyses the footprint by GHG Protocol scope and by emission category, identifying the categories that contribute most to the total and are therefore the focus of the reduction actions.</p>" +
      "<p>Where a category is included in the boundary but no activity was recorded, it is shown with a nil value rather than omitted, so the completeness of the assessment is visible.</p>",
  },
  {
    key: "reduction-actions",
    title: "Carbon reduction actions",
    ordinal: 60,
    defaultBodyHtml:
      "<p>The organisation has identified a set of carbon reduction actions, classified by term, and targeted at the categories that drive the footprint. Each action is owned, scheduled and tracked against the baseline established by this report.</p>" +
      "<p>Progress against these actions is reviewed at least annually alongside the recalculated footprint.</p>",
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
