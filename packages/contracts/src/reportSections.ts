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
    intensityTarget: { denominatorUnit: string; reportingDenominator: number } | null;
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
  {
    key: "executive-summary",
    title: "Executive summary",
    ordinal: 10,
    defaultBodyHtml:
      "<p>The organisation recorded total greenhouse gas emissions of <span data-token=\"total\"></span> for the <span data-token=\"reportingYear\"></span> reporting year, comprising <span data-token=\"scope1\"></span> from Scope 1, <span data-token=\"scope2\"></span> from Scope 2 and <span data-token=\"scope3\"></span> from Scope 3. This report is prepared in accordance with the GHG Protocol Corporate Accounting and Reporting Standard, under the operational control boundary.</p>" +
      "<p>Scope 3 value-chain activity represents <span data-token=\"scope3Pct\"></span> of the total footprint. The report sets out the reduction pathway to net zero and the prioritised carbon reduction actions, and records the reviewed evidence from which every figure in this document is derived.</p>",
    aiBodyHtml:
      "<p>In the <span data-token=\"reportingYear\"></span> reporting year the organisation's measured footprint totalled <span data-token=\"total\"></span>, of which value-chain (Scope 3) emissions represent <span data-token=\"scope3Pct\"></span>. Direct emissions were modest — <span data-token=\"scope1\"></span> in Scope 1 and <span data-token=\"scope2\"></span> in Scope 2.</p>" +
      "<p>This report sets a pathway to net zero by <span data-token=\"netZeroYear\"></span> with an interim milestone of <span data-token=\"interimReductionPct\"></span> by <span data-token=\"interimYear\"></span>, using this year as the immutable baseline for tracking reductions.</p>",
  },
  {
    key: "net-zero-commitment",
    title: "Net zero commitment",
    ordinal: 20,
    defaultBodyHtml:
      "<p>The organisation is committed to achieving net zero greenhouse gas emissions across all scopes by <span data-token=\"netZeroYear\"></span>, supported by a credible, evidence-led reduction pathway with an interim milestone of <span data-token=\"interimReductionPct\"></span> by <span data-token=\"interimYear\"></span>. These targets are anchored to the <span data-token=\"baselineTotal\"></span> baseline established for <span data-token=\"baselineYear\"></span>.</p>" +
      "<ul><li>Achieve the reduction targets set out in this plan.</li><li>Set realistic short- and long-term targets consistent with the net zero commitment.</li><li>Report total greenhouse gas emissions at least annually.</li></ul>",
    aiBodyHtml:
      "<p>The organisation has set a clear ambition: net zero across every scope by <span data-token=\"netZeroYear\"></span>, underpinned by an interim <span data-token=\"interimReductionPct\"></span> reduction by <span data-token=\"interimYear\"></span>. Both targets are measured against the <span data-token=\"baselineTotal\"></span> baseline for <span data-token=\"baselineYear\"></span> and are reported at least annually.</p>",
  },
  {
    key: "background",
    title: "Background & organisation",
    ordinal: 30,
    defaultBodyHtml:
      "<p>This section describes the reporting organisation, the nature of its operations and the organisational boundary applied to this assessment. Emissions are consolidated using the operational control approach unless stated otherwise, for the <span data-token=\"reportingYear\"></span> reporting year.</p>" +
      "<p>The methodology and boundary decisions are recorded in the standards and methodology section and in the assurance record.</p>",
    aiBodyHtml:
      "<p>Emissions are reported for the <span data-token=\"reportingYear\"></span> reporting year under the operational control boundary, following the GHG Protocol Corporate Standard. As a limited-asset organisation, the emissions profile is dominated by value-chain activity rather than direct operations — a pattern reflected throughout this report.</p>",
  },
  {
    key: "intensity-analysis",
    title: "Intensity metric analysis",
    ordinal: 40,
    defaultBodyHtml:
      "<p>Intensity metrics normalise emissions against a measure of business activity so that performance can be compared year on year regardless of changes in the scale of operations.</p>" +
      "<p>For the <span data-token=\"reportingYear\"></span> reporting year the emissions intensity is <span data-token=\"intensityValue\"></span> <span data-token=\"intensityUnit\"></span>, projected forward on the same pathway as absolute emissions.</p>",
    aiBodyHtml:
      "<p>Normalised to activity, the <span data-token=\"reportingYear\"></span> baseline sits at <span data-token=\"intensityValue\"></span> <span data-token=\"intensityUnit\"></span>. This per-unit measure is the fairest way to judge progress as the organisation changes scale, and is projected to fall on the same pathway as absolute emissions to <span data-token=\"netZeroYear\"></span>.</p>",
  },
  {
    key: "category-analysis",
    title: "Emissions by scope & category",
    ordinal: 50,
    defaultBodyHtml:
      "<p>For the <span data-token=\"reportingYear\"></span> reporting year total measured carbon emissions are <span data-token=\"total\"></span>. Scope 3 dominates the profile at <span data-token=\"scope3\"></span> (<span data-token=\"scope3Pct\"></span>), followed by Scope 1 at <span data-token=\"scope1\"></span> and Scope 2 at <span data-token=\"scope2\"></span>.</p>" +
      "<p>Where a category is included in the boundary but no activity was recorded, it is shown with a nil value rather than omitted, so the completeness of the assessment is visible. The categories that contribute most to the total are the focus of the reduction actions.</p>",
    aiBodyHtml:
      "<p>The category profile for <span data-token=\"reportingYear\"></span> is weighted toward the value chain: Scope 3 contributes <span data-token=\"scope3\"></span> (<span data-token=\"scope3Pct\"></span>) of the <span data-token=\"total\"></span> total, against <span data-token=\"scope1\"></span> in Scope 1 and <span data-token=\"scope2\"></span> in Scope 2.</p>" +
      "<p>Categories included in the boundary with no recorded activity are shown at nil rather than omitted, so the completeness of the assessment is visible. The largest categories are the highest-leverage targets for reduction.</p>",
  },
  {
    key: "reduction-actions",
    title: "Carbon reduction actions",
    ordinal: 60,
    defaultBodyHtml:
      "<p>The organisation has identified a set of carbon reduction actions, classified by term, and targeted at the categories that drive the <span data-token=\"total\"></span> footprint. Each action is owned, scheduled and tracked against the baseline established by this report.</p>" +
      "<p>Progress against these actions is reviewed at least annually alongside the recalculated footprint, on the pathway to <span data-token=\"interimReductionPct\"></span> by <span data-token=\"interimYear\"></span> and net zero by <span data-token=\"netZeroYear\"></span>.</p>",
    aiBodyHtml:
      "<p>The action plan addresses the <span data-token=\"total\"></span> footprint, concentrating effort on the categories that drive it. Each action is owned, scheduled and tracked against this year's baseline.</p>" +
      "<p>Progress is reviewed at least annually alongside the recalculated footprint, on the pathway to <span data-token=\"interimReductionPct\"></span> by <span data-token=\"interimYear\"></span> and net zero by <span data-token=\"netZeroYear\"></span>.</p>",
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
