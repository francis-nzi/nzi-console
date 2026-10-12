import type { AnyChartData, ChartType, JobFamily } from "./types";

/**
 * A manifest chart. `reportSection` names the report section the chart is drawn in, when that section can be left out of a
 * report (RULING-report-studio-consolidation R4): a chart in an excluded section is not required. `requiredWhen: "multi-year"`
 * marks a chart that only exists with two or more reporting years (R5): for a single-year client it is absent, not a blocker.
 */
export type ReportManifestChart = {
  id: string; type: ChartType; specVersion: number; required: boolean;
  reportSection?: string; requiredWhen?: "always" | "multi-year";
};
export type ReportManifestSection = {
  id: string;
  title: string;
  description?: string;
  layout: "two-column" | "full-width";
  chartIds: string[];
};
export type ReportManifest = {
  id: string;
  family: JobFamily;
  version: number;
  charts: ReportManifestChart[];
  sections: ReportManifestSection[];
};
export type ManifestIssue = {
  code: "missing_required_chart" | "chart_failed" | "chart_not_successful" | "wrong_chart_type" |
    "wrong_spec_version" | "wrong_family" | "snapshot_mismatch" | "missing_provenance";
  chartId: string;
  message: string;
};
/** A required chart that is not part of this report, and why — shown, never treated as a failure. */
export type ManifestAbsence = { chartId: string; reason: "excluded-section" | "single-year"; reportSection?: string };
export type ManifestValidation = {
  valid: boolean; manifestId: string; manifestVersion: number; reviewedSnapshotId: string; issues: ManifestIssue[];
  /** Charts the report leaves out by its own plan or data: an excluded section, or a single reporting year. */
  absent: ManifestAbsence[];
};
/** What the report itself decides: the sections its plan leaves out, and how many reporting years its snapshot holds. */
export type ManifestContext = { excludedSections?: readonly string[]; reportingYears?: number };

/** Whether a required chart is out of this report, and why (null: it is in, and must resolve). */
export function manifestChartAbsence(requirement: ReportManifestChart, context: ManifestContext = {}): ManifestAbsence | null {
  if (requirement.reportSection && (context.excludedSections ?? []).includes(requirement.reportSection))
    return { chartId: requirement.id, reason: "excluded-section", reportSection: requirement.reportSection };
  if (requirement.requiredWhen === "multi-year" && context.reportingYears !== undefined && context.reportingYears < 2)
    return { chartId: requirement.id, reason: "single-year" };
  return null;
}

export function validateManifest(manifest: ReportManifest, charts: AnyChartData[], reviewedSnapshotId: string, context: ManifestContext = {}): ManifestValidation {
  const byId = new Map(charts.map((chart) => [chart.spec.id, chart]));
  const issues: ManifestIssue[] = [];
  const absent: ManifestAbsence[] = [];
  for (const requirement of manifest.charts) {
    const chart = byId.get(requirement.id);
    const absence = requirement.required ? manifestChartAbsence(requirement, context) : null;
    if (!chart) {
      if (absence) absent.push(absence);
      else if (requirement.required) issues.push({ code: "missing_required_chart", chartId: requirement.id, message: missingMessage(requirement) });
      continue;
    }
    // A chart that resolved is held to every check, whether or not its section is in the report.
    if (chart.spec.family !== manifest.family) issues.push({ code: "wrong_family", chartId: requirement.id, message: "Chart family does not match the report manifest." });
    if (chart.spec.type !== requirement.type) issues.push({ code: "wrong_chart_type", chartId: requirement.id, message: "Resolved chart type does not match the manifest." });
    if (chart.spec.specVersion !== requirement.specVersion) issues.push({ code: "wrong_spec_version", chartId: requirement.id, message: "Chart specification version does not match the manifest." });
    if (chart.state === "failed") issues.push({ code: "chart_failed", chartId: requirement.id, message: chart.stateMessage ?? "Chart rendering failed." });
    else if (requirement.required && !absence && chart.state !== "success") issues.push({ code: "chart_not_successful", chartId: requirement.id, message: chart.stateMessage ?? `Required chart is ${chart.state}.` });
    if (chart.provenance.reviewedSnapshotId !== reviewedSnapshotId) issues.push({ code: "snapshot_mismatch", chartId: requirement.id, message: "Chart was not resolved from the current reviewed snapshot." });
    if (!chart.provenance.dataHash || chart.provenance.factorSets.length === 0) issues.push({ code: "missing_provenance", chartId: requirement.id, message: "Chart provenance is incomplete." });
  }
  return { valid: issues.length === 0, manifestId: manifest.id, manifestVersion: manifest.version, reviewedSnapshotId, issues, absent };
}

/** A missing chart's refusal says what would resolve it: its data, or leaving its section out of this report. */
function missingMessage(requirement: ReportManifestChart): string {
  return requirement.reportSection
    ? `Required chart ${requirement.id} could not be resolved — its data is not in this snapshot. Leave the "${requirement.reportSection}" section out of this report, or add the data and re-freeze.`
    : `Required chart ${requirement.id} could not be resolved.`;
}

export function assertPublishable(validation: ManifestValidation): void {
  if (!validation.valid) throw new Error(`Publication blocked: ${validation.issues.map((issue) => issue.message).join(" ")}`);
}
