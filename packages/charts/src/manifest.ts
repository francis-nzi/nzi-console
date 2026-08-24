import type { AnyChartData, ChartType, JobFamily } from "./types";

export type ReportManifestChart = { id: string; type: ChartType; specVersion: number; required: boolean };
export type ReportManifest = { id: string; family: JobFamily; version: number; charts: ReportManifestChart[] };
export type ManifestIssue = {
  code: "missing_required_chart" | "chart_failed" | "chart_not_successful" | "wrong_chart_type" |
    "wrong_spec_version" | "wrong_family" | "snapshot_mismatch" | "missing_provenance";
  chartId: string;
  message: string;
};
export type ManifestValidation = { valid: boolean; manifestId: string; manifestVersion: number; reviewedSnapshotId: string; issues: ManifestIssue[] };

export function validateManifest(manifest: ReportManifest, charts: AnyChartData[], reviewedSnapshotId: string): ManifestValidation {
  const byId = new Map(charts.map((chart) => [chart.spec.id, chart]));
  const issues: ManifestIssue[] = [];
  for (const requirement of manifest.charts) {
    const chart = byId.get(requirement.id);
    if (!chart) {
      if (requirement.required) issues.push({ code: "missing_required_chart", chartId: requirement.id, message: `Required chart ${requirement.id} could not be resolved.` });
      continue;
    }
    if (chart.spec.family !== manifest.family) issues.push({ code: "wrong_family", chartId: requirement.id, message: "Chart family does not match the report manifest." });
    if (chart.spec.type !== requirement.type) issues.push({ code: "wrong_chart_type", chartId: requirement.id, message: "Resolved chart type does not match the manifest." });
    if (chart.spec.specVersion !== requirement.specVersion) issues.push({ code: "wrong_spec_version", chartId: requirement.id, message: "Chart specification version does not match the manifest." });
    if (chart.state === "failed") issues.push({ code: "chart_failed", chartId: requirement.id, message: chart.stateMessage ?? "Chart rendering failed." });
    else if (requirement.required && chart.state !== "success") issues.push({ code: "chart_not_successful", chartId: requirement.id, message: chart.stateMessage ?? `Required chart is ${chart.state}.` });
    if (chart.provenance.reviewedSnapshotId !== reviewedSnapshotId) issues.push({ code: "snapshot_mismatch", chartId: requirement.id, message: "Chart was not resolved from the current reviewed snapshot." });
    if (!chart.provenance.dataHash || chart.provenance.factorSets.length === 0) issues.push({ code: "missing_provenance", chartId: requirement.id, message: "Chart provenance is incomplete." });
  }
  return { valid: issues.length === 0, manifestId: manifest.id, manifestVersion: manifest.version, reviewedSnapshotId, issues };
}

export function assertPublishable(validation: ManifestValidation): void {
  if (!validation.valid) throw new Error(`Publication blocked: ${validation.issues.map((issue) => issue.message).join(" ")}`);
}
