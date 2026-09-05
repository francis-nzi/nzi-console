// @nzi/charts — LCA/PCF chart resolver + report manifest (Track C L6/L7).
// One reviewed/frozen result snapshot → the deterministic SVG chart set the
// LCA (or PCF) report cites. Mirrors crp.ts. PCF jobs keep the NZC-039
// "Product Carbon Footprint" label; LCA jobs keep LCA terminology.
import { RENDERER_VERSION } from "./identity";
import type { ReportManifest } from "./manifest";
import { TOKENS_VERSION } from "./tokens";
import type { AnyChartData, LcaHotspotsBarData, LcaModuleDonutData, LcaModuleGroup } from "./types";

export const LCA_RESOLVER_VERSION = 1;

/** EN 15804 module label + group (mirrors migration 0045's lca_modules seed). */
const MODULE_META: Record<string, { label: string; group: LcaModuleGroup }> = {
  A1: { label: "A1 Raw material supply", group: "product" },
  A2: { label: "A2 Transport to manufacturer", group: "transport" },
  A3: { label: "A3 Manufacturing", group: "product" },
  A4: { label: "A4 Transport to site/user", group: "transport" },
  A5: { label: "A5 Construction / installation", group: "transport" },
  B1: { label: "B1 Use", group: "use" }, B2: { label: "B2 Maintenance", group: "use" },
  B3: { label: "B3 Repair", group: "use" }, B4: { label: "B4 Replacement", group: "use" },
  B5: { label: "B5 Refurbishment", group: "use" }, B6: { label: "B6 Operational energy", group: "use" },
  B7: { label: "B7 Operational water", group: "use" },
  C1: { label: "C1 Deconstruction", group: "end_of_life" }, C2: { label: "C2 Transport to waste", group: "end_of_life" },
  C3: { label: "C3 Waste processing", group: "end_of_life" }, C4: { label: "C4 Disposal", group: "end_of_life" },
  D: { label: "D Beyond the boundary", group: "benefits" },
};
const moduleMeta = (code: string) => MODULE_META[code] ?? { label: code, group: "product" as LcaModuleGroup };

export type ReviewedLcaSnapshot = {
  id: string;
  jobId: string;
  jobNumber: string;
  client: string;
  assessmentName: string;
  /** the functional unit label, e.g. "filled pack" or "device" */
  functionalUnit: string;
  standard: string;
  isPcf: boolean;
  generatedAt: string;
  dataHash: string;
  factorSets: string[];
  totalTco2e: number;
  moduleBreakdown: Array<{ moduleCode: string; tco2e: number }>;
  hotspots: Array<{ lineItemId: string; label: string; tco2e: number; sharePct: number; moduleCode?: string }>;
};

function lcaManifest(family: "lca" | "pcf"): ReportManifest {
  const noun = family === "pcf" ? "Product Carbon Footprint" : "Life-cycle assessment";
  return {
    id: `${family}_professional`,
    family,
    version: 1,
    charts: [
      { id: "lca_module_donut", type: "lca_module_donut", specVersion: 1, required: true },
      { id: "lca_hotspots_bar", type: "lca_hotspots_bar", specVersion: 1, required: true },
    ],
    sections: [
      {
        id: "footprint",
        title: `${noun} footprint`,
        description: "Emissions by EN 15804 life-cycle module and the largest single contributors.",
        layout: "two-column",
        chartIds: ["lca_module_donut", "lca_hotspots_bar"],
      },
    ],
  };
}
export const lcaProfessionalManifest = lcaManifest("lca");
export const pcfProfessionalManifest = lcaManifest("pcf");

export function resolveLcaCharts(snapshot: ReviewedLcaSnapshot): [LcaModuleDonutData, LcaHotspotsBarData] {
  const family = snapshot.isPcf ? ("pcf" as const) : ("lca" as const);
  const noun = snapshot.isPcf ? "Product Carbon Footprint" : "Life-cycle emissions";
  const modules = snapshot.moduleBreakdown
    .map((entry) => ({ code: entry.moduleCode, ...moduleMeta(entry.moduleCode), value: entry.tco2e }))
    .filter((entry) => entry.value > 0);
  const provenance = {
    jobId: snapshot.jobId,
    dataHash: snapshot.dataHash,
    factorSets: [...snapshot.factorSets].sort(),
    generatedAt: snapshot.generatedAt,
    reviewedSnapshotId: snapshot.id,
    resolverVersion: LCA_RESOLVER_VERSION,
    tokensVersion: TOKENS_VERSION,
    rendererVersion: RENDERER_VERSION,
  };
  const state = modules.length === 0 ? ("empty" as const) : ("success" as const);
  const stateMessage = state === "empty" ? "No calculated life-cycle emissions are available in the reviewed snapshot." : undefined;
  const subtitle = `${snapshot.client} · ${snapshot.jobNumber} · ${snapshot.assessmentName}`;

  return [
    {
      spec: { id: "lca_module_donut", type: "lca_module_donut", title: `${noun} by life-cycle module`, subtitle, family, specVersion: 1 },
      unit: "tCO₂e", state, stateMessage,
      functionalUnit: snapshot.functionalUnit,
      total: snapshot.totalTco2e,
      modules,
      provenance,
    },
    {
      spec: { id: "lca_hotspots_bar", type: "lca_hotspots_bar", title: "Emission hotspots", subtitle, family, specVersion: 1 },
      unit: "tCO₂e", state, stateMessage,
      functionalUnit: snapshot.functionalUnit,
      hotspots: [...snapshot.hotspots]
        .sort((a, b) => b.tco2e - a.tco2e)
        .map((h) => ({ id: h.lineItemId, label: h.label, group: moduleMeta(h.moduleCode ?? "").group, value: h.tco2e, sharePct: h.sharePct })),
      provenance,
    },
  ];
}

export function resolveLcaChartSet(snapshot: ReviewedLcaSnapshot): AnyChartData[] {
  return resolveLcaCharts(snapshot);
}
