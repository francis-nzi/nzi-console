export type Dataset = {
  id: string;
  name: string;
  version: string;
  validFrom: string;
  validTo: string;
  country: string;
  scopes: Array<"1" | "2" | "3">;
  method: "activity" | "spend";
  source: string;
  analysisType: "government" | "environmentally-extended-input-output";
  year: number;
  licence: string;
  status: "active" | "superseded" | "draft";
  factorCount: number;
  usedByJobs: number;
};

export type DatasetSelection = {
  dataset: Dataset;
  source: "automatic" | "manual";
  reason: string;
  warnings: string[];
};

export const datasets: Dataset[] = [
  { id: "defra-2024", name: "DEFRA", version: "2024 v1.2", validFrom: "2024-01-01", validTo: "2024-12-31", country: "GB", scopes: ["1", "3"], method: "activity", source: "UK Government GHG Conversion Factors", analysisType: "government", year: 2024, licence: "Open Government Licence v3.0", status: "active", factorCount: 1132, usedByJobs: 28 },
  { id: "desnz-2024", name: "DESNZ UK grid", version: "2024 v1.0", validFrom: "2024-01-01", validTo: "2024-12-31", country: "GB", scopes: ["2"], method: "activity", source: "Department for Energy Security and Net Zero", analysisType: "government", year: 2024, licence: "Open Government Licence v3.0", status: "active", factorCount: 42, usedByJobs: 24 },
  { id: "ceda-2024", name: "CEDA", version: "2024 v1.0", validFrom: "2024-01-01", validTo: "2024-12-31", country: "GLOBAL", scopes: ["3"], method: "spend", source: "Comprehensive Environmental Data Archive", analysisType: "environmentally-extended-input-output", year: 2024, licence: "Commercial NZI licence", status: "active", factorCount: 486, usedByJobs: 16 },
  { id: "defra-2023", name: "DEFRA", version: "2023 v1.1", validFrom: "2023-01-01", validTo: "2023-12-31", country: "GB", scopes: ["1", "3"], method: "activity", source: "UK Government GHG Conversion Factors", analysisType: "government", year: 2023, licence: "Open Government Licence v3.0", status: "superseded", factorCount: 1084, usedByJobs: 31 },
  { id: "epa-2024", name: "US EPA", version: "2024", validFrom: "2024-01-01", validTo: "2024-12-31", country: "US", scopes: ["1", "2", "3"], method: "activity", source: "United States Environmental Protection Agency", analysisType: "government", year: 2024, licence: "Public domain", status: "active", factorCount: 724, usedByJobs: 3 },
];

export type DatasetAuditIssue = { id: string; severity: "warning" | "error"; datasetId: string; jobNumber: string; message: string; state: "open" | "resolved" };
export const datasetAuditIssues: DatasetAuditIssue[] = [
  { id: "audit-1", severity: "error", datasetId: "epa-2024", jobNumber: "J000712", message: "US dataset manually added to a GB job; reviewer justification required.", state: "open" },
  { id: "audit-2", severity: "warning", datasetId: "defra-2023", jobNumber: "J000699", message: "Superseded dataset remains correctly pinned to a 2023 reviewed report version.", state: "resolved" },
];

export function datasetApplies(dataset: Dataset, input: { reportingFrom: string; reportingTo: string; country: string }): boolean {
  return dataset.validFrom <= input.reportingFrom && dataset.validTo >= input.reportingTo && (dataset.country === input.country || dataset.country === "GLOBAL");
}

export function recommendDatasets(input: { reportingFrom: string; reportingTo: string; country: string }): DatasetSelection[] {
  return datasets
    .filter((dataset) => dataset.status === "active" && datasetApplies(dataset, input))
    .map((dataset) => ({ dataset, source: "automatic" as const, reason: "Matched reporting period, geography, scope and factor method.", warnings: [] }));
}

export function addManualDataset(datasetId: string, context: { reportingFrom: string; reportingTo: string; country: string }, reason: string): DatasetSelection {
  const dataset = datasets.find((item) => item.id === datasetId);
  if (!dataset) throw new Error(`Unknown dataset: ${datasetId}`);
  if (!reason.trim()) throw new Error("A reason is required when adding a dataset manually.");
  const warnings: string[] = [];
  if (dataset.validFrom > context.reportingFrom || dataset.validTo < context.reportingTo) warnings.push("Dataset does not cover the complete reporting period.");
  if (dataset.country !== context.country && dataset.country !== "GLOBAL") warnings.push(`Dataset geography ${dataset.country} differs from job geography ${context.country}.`);
  return { dataset, source: "manual", reason: reason.trim(), warnings };
}
