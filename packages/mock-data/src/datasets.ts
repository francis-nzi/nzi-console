export type Dataset = {
  id: string;
  name: string;
  version: string;
  validFrom: string;
  validTo: string;
  country: string;
  scopes: Array<"1" | "2" | "3">;
  method: "activity" | "spend";
};

export type DatasetSelection = {
  dataset: Dataset;
  source: "automatic" | "manual";
  reason: string;
  warnings: string[];
};

export const datasets: Dataset[] = [
  { id: "defra-2024", name: "DEFRA", version: "2024 v1.2", validFrom: "2024-01-01", validTo: "2024-12-31", country: "GB", scopes: ["1", "3"], method: "activity" },
  { id: "desnz-2024", name: "DESNZ UK grid", version: "2024 v1.0", validFrom: "2024-01-01", validTo: "2024-12-31", country: "GB", scopes: ["2"], method: "activity" },
  { id: "ceda-2024", name: "CEDA", version: "2024 v1.0", validFrom: "2024-01-01", validTo: "2024-12-31", country: "GLOBAL", scopes: ["3"], method: "spend" },
  { id: "defra-2023", name: "DEFRA", version: "2023 v1.1", validFrom: "2023-01-01", validTo: "2023-12-31", country: "GB", scopes: ["1", "3"], method: "activity" },
  { id: "epa-2024", name: "US EPA", version: "2024", validFrom: "2024-01-01", validTo: "2024-12-31", country: "US", scopes: ["1", "2", "3"], method: "activity" },
];

export function recommendDatasets(input: { reportingFrom: string; reportingTo: string; country: string }): DatasetSelection[] {
  return datasets
    .filter((dataset) => dataset.validFrom <= input.reportingFrom && dataset.validTo >= input.reportingTo)
    .filter((dataset) => dataset.country === input.country || dataset.country === "GLOBAL")
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
