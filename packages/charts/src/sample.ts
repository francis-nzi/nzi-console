// Illustrative sample data for @nzi/charts — no real client data.
// Derived from the Job #712 mock (Bushy Tails Ltd, 2024) in @nzi/mock-data:
// scope totals aggregated from its scope rows, and a plausible trajectory to
// the client's net-zero target. Provenance is fixed (never Date.now()).

import type { ScopeDonutData, ReductionPathwayData } from "./types";

const GENERATED_AT = "2026-08-24T00:00:00Z";
const FACTOR_SETS = ["DEFRA 2024 v1.2", "DESNZ 2024 v1.0", "CEDA 2025 v1.0"];

export const scopeDonutSample: ScopeDonutData = {
  spec: {
    id: "emissions_scope_donut",
    type: "emissions_scope_donut",
    title: "2024 carbon footprint by scope",
    subtitle: "Bushy Tails Ltd · Job #712",
    family: "crp",
    specVersion: 1,
  },
  unit: "tCO₂e",
  segments: [
    { scope: "1", label: "Scope 1 — direct", value: 146.0 },
    { scope: "2", label: "Scope 2 — electricity", value: 96.1 },
    { scope: "3", label: "Scope 3 — value chain", value: 1175.9 },
  ],
  provenance: {
    jobId: "712",
    dataHash: "demo-sha-scope-9f3a",
    factorSets: FACTOR_SETS,
    generatedAt: GENERATED_AT,
    quality: "Measured",
  },
};

export const reductionPathwaySample: ReductionPathwayData = {
  spec: {
    id: "reduction_pathway",
    type: "reduction_pathway",
    title: "Emissions reduction pathway to net zero",
    subtitle: "Bushy Tails Ltd · baseline 2022 → net zero 2045",
    family: "crp",
    specVersion: 1,
  },
  unit: "tCO₂e",
  actual: [
    { year: 2022, value: 1650 },
    { year: 2023, value: 1548 },
    { year: 2024, value: 1418 },
  ],
  target: [
    { year: 2022, value: 1650 },
    { year: 2035, value: 825 },
    { year: 2045, value: 0 },
  ],
  milestones: [
    { year: 2022, value: 1650, label: "Baseline", kind: "baseline" },
    { year: 2035, value: 825, label: "Interim −50%", kind: "interim" },
    { year: 2045, value: 0, label: "Net zero", kind: "netzero" },
  ],
  provenance: {
    jobId: "712",
    dataHash: "demo-sha-pathway-4c17",
    factorSets: FACTOR_SETS,
    generatedAt: GENERATED_AT,
    quality: "Measured",
  },
};
