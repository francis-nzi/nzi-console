import { resolveCrpCharts, type ReviewedCrpSnapshot } from "./crp";
import type { EmissionsByActivityData, ScopeYearOnYearData } from "./types";

export const reviewedCrpSnapshotSample: ReviewedCrpSnapshot = {
  id: "reviewed-crp-J000712-v1",
  jobId: "712",
  jobNumber: "J000712",
  client: "Bushy Tails Ltd",
  reportingYear: 2024,
  generatedAt: "2026-08-24T00:00:00Z",
  dataHash: "sha256-demo-reviewed-crp-J000712-v1",
  measurements: [
    { scope: "1", tco2e: 146, factorSet: "DEFRA 2024 v1.2", reviewed: true, included: true },
    { scope: "2", tco2e: 96.1, factorSet: "DESNZ 2024 v1.0", reviewed: true, included: true },
    { scope: "3", tco2e: 1175.9, factorSet: "CEDA 2025 v1.0", reviewed: true, included: true },
  ],
  pathway: {
    actual: [{ year: 2022, value: 1650 }, { year: 2023, value: 1548 }, { year: 2024, value: 1418 }],
    target: [{ year: 2022, value: 1650 }, { year: 2035, value: 825 }, { year: 2045, value: 0 }],
    milestones: [
      { year: 2022, value: 1650, label: "Baseline", kind: "baseline" },
      { year: 2035, value: 825, label: "Interim −50%", kind: "interim" },
      { year: 2045, value: 0, label: "Net zero", kind: "netzero" },
    ],
  },
};

export const [scopeDonutSample, reductionPathwaySample] = resolveCrpCharts(reviewedCrpSnapshotSample);

const sharedProvenance = scopeDonutSample.provenance;

export const scopeYearOnYearSample: ScopeYearOnYearData = {
  spec: { id: "scope_year_on_year_bar", type: "scope_year_on_year_bar", title: "Annual emissions comparison by scope", subtitle: "Bushy Tails Ltd · J000712", family: "crp", specVersion: 1 },
  unit: "tCO₂e", state: "success", provenance: sharedProvenance,
  years: [
    { year: 2022, values: [{ scope: "1", value: 182 }, { scope: "2", value: 128 }, { scope: "3", value: 1340 }] },
    { year: 2023, values: [{ scope: "1", value: 165 }, { scope: "2", value: 111 }, { scope: "3", value: 1272 }] },
    { year: 2024, values: [{ scope: "1", value: 146 }, { scope: "2", value: 96 }, { scope: "3", value: 1176 }] },
  ],
};

export const emissionsByActivitySample: EmissionsByActivityData = {
  spec: { id: "emissions_by_activity", type: "emissions_by_activity", title: "Largest emissions activities", subtitle: "Bushy Tails Ltd · J000712", family: "crp", specVersion: 1 },
  unit: "tCO₂e", state: "success", provenance: sharedProvenance,
  activities: [
    { id: "purchased-goods", label: "Purchased goods", scope: "3", value: 686.3 },
    { id: "freight", label: "Upstream freight", scope: "3", value: 412.7 },
    { id: "diesel", label: "Company vehicle diesel", scope: "1", value: 128.4 },
    { id: "electricity", label: "Purchased electricity", scope: "2", value: 96.1 },
    { id: "commuting", label: "Employee commuting", scope: "3", value: 74.8 },
    { id: "natural-gas", label: "Natural gas", scope: "1", value: 17.6 },
  ],
};
