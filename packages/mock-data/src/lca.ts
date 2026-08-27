export type AssessmentKind = "lca" | "pcf";
export type MappingState = "mapped" | "review" | "unmapped";

export type LcaLineItem = {
  id: string;
  component: string;
  supplier: string;
  category: string;
  module: string;
  quantity: number;
  unit: string;
  factor: string | null;
  dataset: string | null;
  confidence: "high" | "medium" | "low";
  mappingState: MappingState;
  kgCo2e: number | null;
  evidence: string;
};

export type LcaAssessment = {
  id: string;
  jobId: string;
  jobNumber: string;
  kind: AssessmentKind;
  client: string;
  product: string;
  functionalUnit: string;
  boundary: string;
  standard: string;
  stage: string;
  owner: string;
  updatedAt: string;
  lines: LcaLineItem[];
  transportLegs: number;
  mappedTransportLegs: number;
  scenarios: { id: string; name: string; kgCo2e: number; deltaPct: number; note: string }[];
};

export const lcaAssessments: LcaAssessment[] = [
  {
    id: "assess-714", jobId: "714", jobNumber: "J000714", kind: "lca", client: "Verdant Foods Co",
    product: "Recyclable food packaging", functionalUnit: "1,000 filled 750 ml packs", boundary: "Cradle-to-grave",
    standard: "ISO 14040 / ISO 14044", stage: "Inventory", owner: "A. Shaw", updatedAt: "25 Aug 2026, 09:42",
    transportLegs: 8, mappedTransportLegs: 7,
    lines: [
      { id: "tray", component: "rPET tray", supplier: "Circular Polymer UK", category: "Polymers", module: "A1–A3", quantity: 31.5, unit: "kg", factor: "Recycled PET granulate", dataset: "Ecoinvent 3.10 · cut-off", confidence: "high", mappingState: "mapped", kgCo2e: 52.9, evidence: "Supplier mass declaration · batch VP-2408" },
      { id: "film", component: "Lidding film", supplier: "FlexSeal Europe", category: "Flexible film", module: "A1–A3", quantity: 4.8, unit: "kg", factor: "Polyethylene film, Europe", dataset: "Ecoinvent 3.10 · cut-off", confidence: "medium", mappingState: "review", kgCo2e: 12.6, evidence: "Specification sheet; polymer blend requires reviewer confirmation" },
      { id: "label", component: "Paper label", supplier: "North Print", category: "Paper", module: "A1–A3", quantity: 1.2, unit: "kg", factor: "Graphic paper, coated", dataset: "DEFRA 2025 · v1.0", confidence: "high", mappingState: "mapped", kgCo2e: 1.1, evidence: "Purchase specification NP-118" },
      { id: "adhesive", component: "Food-grade adhesive", supplier: "Not supplied", category: "Chemicals", module: "A1–A3", quantity: 0.35, unit: "kg", factor: null, dataset: null, confidence: "low", mappingState: "unmapped", kgCo2e: null, evidence: "Supplier composition and technical data requested" },
      { id: "carton", component: "Distribution carton", supplier: "Boxworks Ltd", category: "Packaging", module: "A1–A3", quantity: 9.4, unit: "kg", factor: "Corrugated board box", dataset: "Ecoinvent 3.10 · cut-off", confidence: "high", mappingState: "mapped", kgCo2e: 8.7, evidence: "FSC specification and measured pack weight" },
    ],
    scenarios: [
      { id: "base", name: "Current design", kgCo2e: 112.4, deltaPct: 0, note: "Approved baseline inventory" },
      { id: "light", name: "Lightweight tray", kgCo2e: 101.8, deltaPct: -9.4, note: "15% lower tray mass" },
      { id: "reuse", name: "Reusable format", kgCo2e: 86.7, deltaPct: -22.9, note: "Modelled at 20 use cycles" },
    ],
  },
  {
    id: "assess-715", jobId: "715", jobNumber: "J000715", kind: "pcf", client: "Quaymed Devices",
    product: "QMD Diagnostic Unit", functionalUnit: "One device over its service life", boundary: "Cradle-to-grave",
    standard: "ISO 14067", stage: "Factor mapping", owner: "M. Osei", updatedAt: "24 Aug 2026, 16:18",
    transportLegs: 14, mappedTransportLegs: 11,
    lines: [
      { id: "housing", component: "ABS enclosure", supplier: "MedMould GmbH", category: "Polymers", module: "A1–A3", quantity: 2.4, unit: "kg", factor: "ABS production, Europe", dataset: "Ecoinvent 3.10 · cut-off", confidence: "high", mappingState: "mapped", kgCo2e: 9.8, evidence: "Supplier BOM revision 6" },
      { id: "pcb", component: "Control PCB", supplier: "Electronix Asia", category: "Electronics", module: "A1–A3", quantity: 0.62, unit: "kg", factor: "Printed wiring board", dataset: "Ecoinvent 3.10 · cut-off", confidence: "medium", mappingState: "review", kgCo2e: 61.4, evidence: "Mass known; layer count inferred from drawing" },
      { id: "battery", component: "Lithium battery pack", supplier: "PowerCell", category: "Electronics", module: "A1–A3", quantity: 0.9, unit: "kg", factor: null, dataset: null, confidence: "low", mappingState: "unmapped", kgCo2e: null, evidence: "Supplier-specific PCF requested" },
    ],
    scenarios: [
      { id: "base", name: "Current product", kgCo2e: 284.6, deltaPct: 0, note: "Current mapped inventory" },
      { id: "repair", name: "Repairable design", kgCo2e: 231.2, deltaPct: -18.8, note: "Extended service life to eight years" },
    ],
  },
];

export function assessmentReadiness(assessment: LcaAssessment) {
  const mappedLines = assessment.lines.filter((line) => line.mappingState === "mapped").length;
  const reviewLines = assessment.lines.filter((line) => line.mappingState === "review").length;
  const inventoryPct = assessment.lines.length ? Math.round(((mappedLines + reviewLines) / assessment.lines.length) * 100) : 0;
  const transportPct = assessment.transportLegs ? Math.round((assessment.mappedTransportLegs / assessment.transportLegs) * 100) : 0;
  return { mappedLines, reviewLines, unmappedLines: assessment.lines.length - mappedLines - reviewLines, inventoryPct, transportPct };
}
