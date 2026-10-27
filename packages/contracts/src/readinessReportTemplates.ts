import type { SrsDashboardModel } from "./srsDashboard";

/**
 * Readiness reports as **templates** (SRS S3, R5/R6).
 *
 * A report is data: its cover words, its voice, and an ordered list of sections — each naming a **section kind** the one
 * renderer knows how to draw from the readiness model (S2's components and model). UK SRS is the first template; Evergreen
 * or B Corp later are new entries here, over a framework published the same way (S1's versioned framework is data too),
 * **not** new renderers. What a template cannot do is invent content: every section draws the same assured model, with
 * the same provenance, and the narrative is written from that model's own numbers.
 *
 * Held in code as typed data for now. The admin "Report templates" page (phase H) is the natural home when templates
 * need editing in the console; until then a new template is a reviewed entry in this file.
 */

export const readinessReportSectionKinds = [
  "summary",   // the overall position: step reached, the narrative
  "pillars",   // the four dials, with their table
  "radar",     // the readiness web, with its table
  "heatmap",   // every requirement, by pillar
  "trend",     // completed assessments over time
  "metrics",   // Metrics & targets as the assured record answered them
  "roadmap",   // the gaps, furthest first, and what on the plan addresses each
  "benchmark", // the sector comparison — truthfully "Future" until a peer dataset exists
  "method",    // the framework, the ladder, how the scores are made, provenance
] as const;
export type ReadinessReportSectionKind = (typeof readinessReportSectionKinds)[number];

export type ReadinessReportSection = { kind: ReadinessReportSectionKind; heading: string; intro?: string };

export type ReadinessReportTemplate = {
  key: string;
  version: number;
  /** What the template is called where one is chosen. */
  label: string;
  /** The cover: the document's title and its line beneath. The client's name and the dates are filled from the record. */
  title: string;
  strapline: string;
  sections: ReadinessReportSection[];
  /** What the report is not — said on the cover and in the method. */
  disclaimer: string;
};

export const UK_SRS_REPORT_TEMPLATE: ReadinessReportTemplate = {
  key: "uk-srs",
  version: 1,
  label: "UK SRS readiness",
  title: "UK SRS readiness report",
  strapline: "Where your reporting stands against the UK Sustainability Reporting Standards, and the path to being ready.",
  sections: [
    { kind: "summary", heading: "Summary" },
    { kind: "pillars", heading: "Readiness by pillar", intro: "Each pillar on the five-step ladder, against what the framework expects of it." },
    { kind: "radar", heading: "The readiness web", intro: "The same four positions as one shape, with the expectation drawn beside them." },
    { kind: "heatmap", heading: "Every requirement", intro: "Each requirement's step, grouped by pillar. A notch marks one below what is expected." },
    { kind: "trend", heading: "Readiness over time", intro: "Completed assessments only." },
    { kind: "metrics", heading: "Metrics & targets from your assured record", intro: "Requirements answered from your own reviewed data rather than re-keyed." },
    { kind: "roadmap", heading: "The path to ready", intro: "The furthest short first, with the actions on your plan that advance each one." },
    { kind: "benchmark", heading: "Sector comparison" },
    { kind: "method", heading: "How this report was made" },
  ],
  disclaimer: "This report describes how ready your own reporting is. It is not a statement that anything has been filed, assured or certified.",
};

/** Every template, by key. A new report is a new entry — and must pass `readinessReportTemplateIssues`. */
export const readinessReportTemplates: Readonly<Record<string, ReadinessReportTemplate>> = {
  [UK_SRS_REPORT_TEMPLATE.key]: UK_SRS_REPORT_TEMPLATE,
};

/** What makes a template unusable: an unknown section, a repeated one, no summary or no method, or empty words. */
export function readinessReportTemplateIssues(template: ReadinessReportTemplate): string[] {
  const issues: string[] = [];
  if (!/^[a-z0-9-]+$/.test(template.key)) issues.push("key");
  if (!Number.isInteger(template.version) || template.version < 1) issues.push("version");
  for (const field of ["label", "title", "strapline", "disclaimer"] as const) if (!template[field].trim()) issues.push(field);
  const kinds = template.sections.map((section) => section.kind);
  for (const kind of kinds) if (!(readinessReportSectionKinds as readonly string[]).includes(kind)) issues.push(`unknown section ${kind}`);
  if (new Set(kinds).size !== kinds.length) issues.push("a section appears twice");
  // Every report opens with where the client stands and closes on how it was made — the provenance is not optional.
  if (kinds[0] !== "summary") issues.push("the first section is the summary");
  if (!kinds.includes("method")) issues.push("the method section is required");
  for (const section of template.sections) if (!section.heading.trim()) issues.push(`heading for ${section.kind}`);
  return issues;
}

/**
 * The summary's words, written from the model and nothing else: the step reached, the strongest pillar and the one
 * furthest from what is expected, how many requirements sit below their target, and — only with two or more completed
 * assessments — which way it has moved. Every number here is the model's own; none is estimated.
 */
export function readinessNarrative(model: SrsDashboardModel, clientName: string): string[] {
  const lines: string[] = [];
  lines.push(`${clientName} has reached step ${model.overall.step} of 4, ${model.overall.stepName}, across the requirements assessed (${model.overall.level.toFixed(1)} on the ladder).`);
  if (model.pillars.length > 1) {
    const strongest = [...model.pillars].sort((a, b) => b.level - a.level)[0]!;
    const furthest = [...model.pillars].sort((a, b) => (a.level - a.targetLevel) - (b.level - b.targetLevel))[0]!;
    lines.push(`${strongest.label} is the strongest pillar (${strongest.level.toFixed(1)}, ${strongest.stepName}).`
      + (furthest.level < furthest.targetLevel ? ` ${furthest.label} is furthest from what the framework expects (${furthest.level.toFixed(1)} against ${furthest.targetLevel}).` : ""));
  }
  const gaps = model.requirements.filter((requirement) => requirement.gap).length;
  lines.push(gaps === 0
    ? "No requirement sits below what the framework expects of it."
    : `${gaps} of ${model.requirements.length} requirements sit below what the framework expects; the path to ready below takes them furthest first.`);
  if (model.overall.delta !== null && model.trend.overall.length >= 2) {
    lines.push(model.overall.delta === 0
      ? "Overall readiness is unchanged since the previous assessment."
      : `Overall readiness has ${model.overall.delta > 0 ? "risen" : "fallen"} by ${Math.abs(model.overall.delta).toFixed(1)} of a step since the previous assessment.`);
  }
  return lines;
}
