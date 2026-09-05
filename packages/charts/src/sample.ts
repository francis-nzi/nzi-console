import { resolveCrpCharts, type ReviewedCrpSnapshot } from "./crp";
import { resolveLcaCharts, type ReviewedLcaSnapshot } from "./lca";
import type { AnyChartData, EmissionsByActivityData, IntensityPathwayData, PurchasedGoodsBreakdownData, ScopeYearOnYearData, SiteDonutData } from "./types";

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

export const emissionsSiteDonutSample: SiteDonutData = {
  spec: { id: "emissions_site_donut", type: "emissions_site_donut", title: "Emissions by operating site", subtitle: "Bushy Tails Ltd · J000712", family: "crp", specVersion: 1 },
  unit: "tCO₂e", state: "success", provenance: sharedProvenance,
  sites: [
    { id: "manchester-hq", label: "Manchester HQ", value: 620 },
    { id: "leeds-warehouse", label: "Leeds warehouse", value: 344 },
    { id: "bristol-site", label: "Bristol site", value: 210 },
    { id: "london-office", label: "London office", value: 144 },
    { id: "dublin-office", label: "Dublin office", value: 100 },
  ],
};

export const intensityPathwaySample: IntensityPathwayData = {
  spec: { id: "intensity_pathway", type: "intensity_pathway", title: "Turnover intensity pathway", subtitle: "tCO₂e per £m turnover · J000712", family: "crp", specVersion: 1 },
  unit: "tCO₂e / £m", state: "success", provenance: sharedProvenance, metric: "turnover",
  actual: [{ year: 2022, value: 61.1 }, { year: 2023, value: 54.3 }, { year: 2024, value: 47.8 }],
  target: [{ year: 2022, value: 61.1 }, { year: 2035, value: 30.6 }, { year: 2045, value: 0 }],
  milestones: [{ year: 2022, value: 61.1, label: "Baseline", kind: "baseline" }, { year: 2035, value: 30.6, label: "Interim −50%", kind: "interim" }, { year: 2045, value: 0, label: "Net zero", kind: "netzero" }],
};

export const purchasedGoodsBreakdownSample: PurchasedGoodsBreakdownData = {
  spec: { id: "purchased_goods_breakdown", type: "purchased_goods_breakdown", title: "Purchased Goods & Services emissions breakdown", subtitle: "Scope 3.1 · category view · J000712", family: "crp", specVersion: 1 },
  unit: "tCO₂e", state: "success", provenance: { ...sharedProvenance, quality: "Spend-based" }, basis: "category",
  activities: [
    { id: "raw-materials", label: "Raw materials", scope: "3", value: 238.4 },
    { id: "packaging", label: "Packaging", scope: "3", value: 151.7 },
    { id: "contract-services", label: "Contract services", scope: "3", value: 112.6 },
    { id: "it-telecoms", label: "IT and telecoms", scope: "3", value: 78.9 },
    { id: "professional-services", label: "Professional services", scope: "3", value: 61.2 },
    { id: "other-goods", label: "Other purchased goods", scope: "3", value: 43.5 },
  ],
};

/** Canonical complete CRP chart set used by every demonstrator surface. */
export const crpChartSamples: AnyChartData[] = [
  scopeDonutSample, reductionPathwaySample, scopeYearOnYearSample, emissionsByActivitySample,
  emissionsSiteDonutSample, intensityPathwaySample, purchasedGoodsBreakdownSample,
];

export const reviewedLcaSnapshotSample: ReviewedLcaSnapshot = {
  id: "reviewed-lca-J000714-v1",
  jobId: "714",
  jobNumber: "J000714",
  client: "Verdant Foods Co",
  assessmentName: "Recyclable food pack — 6L variant",
  functionalUnit: "filled pack",
  standard: "ISO 14040 / ISO 14044",
  isPcf: false,
  generatedAt: "2026-09-05T00:00:00Z",
  dataHash: "sha256-demo-reviewed-lca-J000714-v1",
  factorSets: ["ecoinvent 3.10", "DEFRA 2025 freight"],
  totalTco2e: 0.0643,
  moduleBreakdown: [
    { moduleCode: "A1", tco2e: 0.0531 },
    { moduleCode: "A3", tco2e: 0.0002 },
    { moduleCode: "A4", tco2e: 0.011 },
  ],
  hotspots: [
    { lineItemId: "714-6l-tray", label: "rPET tray", tco2e: 0.0529, sharePct: 82, moduleCode: "A1" },
    { lineItemId: "714-6l-inbound-transport", label: "Inbound tray shipment", tco2e: 0.011, sharePct: 17, moduleCode: "A4" },
    { lineItemId: "714-6l-label-ink", label: "Label ink", tco2e: 0.0002, sharePct: 1, moduleCode: "A1" },
  ],
};
export const [lcaModuleDonutSample, lcaHotspotsBarSample] = resolveLcaCharts(reviewedLcaSnapshotSample);
export const lcaChartSamples: AnyChartData[] = [lcaModuleDonutSample, lcaHotspotsBarSample];
