import { resolveCrpCharts, type ReviewedCrpSnapshot } from "./crp";

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
