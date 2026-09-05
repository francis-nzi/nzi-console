// Worst-case LCA/PCF fixtures proving the job-family model (migrations 0045–0047)
// represents real-world intricacies: the Model Register (several assessments per
// job), multi-leg geocoded transport, unmapped + gap-filled + placeholder lines,
// a mass-reconciliation mismatch, and client-scoped vs global components.
// Typed against @nzi/contracts; see docs/MODEL_FIDELITY_JOB_FAMILIES.md §2.
// Illustrative demonstrator data only — no real client data, no PII.
import type { LcaAssessment, LcaComponent, LcaLineItem, LcaResultSnapshot, LcaTransportLeg } from "@nzi/contracts";

const transportLeg = (over: Partial<LcaTransportLeg> & Pick<LcaTransportLeg, "id" | "legOrder" | "fromLabel" | "toLabel" | "mode">): LcaTransportLeg => ({
  fromLat: null, fromLng: null, toLat: null, toLng: null, distanceKm: 0, distanceSource: "manual",
  factorSource: "unmapped", datasetId: null, factorId: null, factorValue: null, calculatedKgco2e: null, notes: "", ...over,
});

const line = (over: Partial<LcaLineItem> & Pick<LcaLineItem, "id" | "lineLabel" | "moduleCode">): LcaLineItem => ({
  assessmentId: "assess-714-6l", componentId: null, materialCategoryId: null, quantity: 0, unit: "kg",
  originCountry: null, energyKwh: null, endOfLifeRoute: null, factorSource: "unmapped", datasetId: null,
  factorId: null, clientFactorId: null, factorValue: null, factorUnit: null, factorLabel: null, factorMatchConfidence: null,
  dataQuality: "secondary", isGapFilled: false, gapFillMethod: null, isPlaceholder: false,
  transportKgco2e: 0, calculatedKgco2e: null, transportLegs: [], notes: "", ...over,
});

// ── Reusable component library — one client-scoped, one global ────────────────
export const rpetTrayComponent: LcaComponent = {
  id: "cmp-rpet-tray", clientId: "verdant", componentCode: "VP-TRAY", description: "rPET food tray, 30% recycled",
  materialCategoryId: "mc-polymers", defaultUnitMass: 31.5, defaultUnit: "kg", originCountry: "GB",
  supplierName: "Circular Polymer UK", archived: false,
};
export const corrugatedBoxComponent: LcaComponent = {
  id: "cmp-corrugated-box", clientId: null, componentCode: "STD-BOX", description: "Corrugated board distribution carton",
  materialCategoryId: "mc-packaging", defaultUnitMass: null, defaultUnit: "kg", originCountry: null,
  supplierName: null, archived: false,
};

// ── Model Register — one job, a 6 L and a 9 L variant of the same product ──────
const registerAssessment = (variant: "6l" | "9l", trayMass: number, total: number): LcaAssessment => ({
  id: `assess-714-${variant}`, jobId: "714", jobNumber: "J000714", clientId: "verdant",
  assessmentType: "product", isPcf: false, name: `Recyclable food pack — ${variant.toUpperCase()} variant`,
  sku: `VP-${variant.toUpperCase()}`, functionalUnitValue: 1000, functionalUnitUnit: "filled packs",
  confirmedQuantity: variant === "6l" ? 31.5 : 44.2, confirmedQuantityUnit: "kg",
  lifecycleBoundary: "cradle_to_grave", includedModules: ["A1", "A2", "A3", "A4", "C3", "C4"],
  standard: "ISO 14040 / ISO 14044", referenceYear: 2025, geography: "GB",
  version: 4, reviewStatus: variant === "6l" ? "approved" : "pending",
  reviewedVersion: variant === "6l" ? 3 : null, totalTco2e: total,
  scenarios: [
    { id: `scn-${variant}-base`, name: "Current design", isBaseline: true, multipliers: [] },
    { id: `scn-${variant}-light`, name: "Lightweight tray", isBaseline: false, multipliers: [{ moduleCode: "A1", materialCategoryId: "mc-polymers", componentId: null, multiplier: 0.85 }] },
  ],
  lines: [
    line({
      id: `${variant}-tray`, assessmentId: `assess-714-${variant}`, componentId: "cmp-rpet-tray", moduleCode: "A1",
      lineLabel: "rPET tray", materialCategoryId: "mc-polymers", quantity: trayMass, unit: "kg", originCountry: "GB",
      factorSource: "dataset", datasetId: "ds-ecoinvent-310", factorId: "f-rpet", factorLabel: "Recycled PET granulate",
      factorMatchConfidence: 0.94, dataQuality: "primary", calculatedKgco2e: trayMass * 1.68,
    }),
    // multi-leg geocoded transport: factory (CN) → port (CN) → port (UK) → client site
    line({
      id: `${variant}-inbound-transport`, assessmentId: `assess-714-${variant}`, moduleCode: "A4",
      lineLabel: "Inbound tray shipment", quantity: trayMass, unit: "kg", factorSource: "manual",
      factorValue: 0, dataQuality: "secondary", transportKgco2e: 6.4, calculatedKgco2e: 6.4,
      transportLegs: [
        transportLeg({ id: `${variant}-leg-1`, legOrder: 0, fromLabel: "Ningbo plant, CN", fromLat: 29.87, fromLng: 121.55, toLabel: "Ningbo port, CN", toLat: 29.95, toLng: 121.85, mode: "road_hgv", distanceKm: 42, distanceSource: "geocoded", factorSource: "dataset", datasetId: "ds-ecoinvent-310", factorId: "f-freight-hgv", calculatedKgco2e: 0.3 }),
        transportLeg({ id: `${variant}-leg-2`, legOrder: 1, fromLabel: "Ningbo port, CN", fromLat: 29.95, fromLng: 121.85, toLabel: "Felixstowe port, UK", toLat: 51.96, toLng: 1.35, mode: "sea", distanceKm: 19600, distanceSource: "geocoded", factorSource: "dataset", datasetId: "ds-ecoinvent-310", factorId: "f-freight-sea", calculatedKgco2e: 5.4 }),
        transportLeg({ id: `${variant}-leg-3`, legOrder: 2, fromLabel: "Felixstowe port, UK", fromLat: 51.96, fromLng: 1.35, toLabel: "Leeds pack site, UK", toLat: 53.8, toLng: -1.55, mode: "road_hgv", distanceKm: 310, distanceSource: "geocoded", factorSource: "dataset", datasetId: "ds-ecoinvent-310", factorId: "f-freight-hgv", calculatedKgco2e: 0.7 }),
      ],
    }),
    // unmapped line — supplier data still outstanding
    line({
      id: `${variant}-adhesive`, assessmentId: `assess-714-${variant}`, moduleCode: "A1", lineLabel: "Food-grade adhesive",
      materialCategoryId: "mc-chemicals", quantity: 0.35, unit: "kg", factorSource: "unmapped", dataQuality: "estimated",
    }),
    // gap-filled proxy line
    line({
      id: `${variant}-label-ink`, assessmentId: `assess-714-${variant}`, moduleCode: "A1", lineLabel: "Label ink",
      quantity: 0.06, unit: "kg", factorSource: "manual", factorValue: 3.1, dataQuality: "proxy",
      isGapFilled: true, gapFillMethod: "Category-average printing ink, DEFRA 2025", calculatedKgco2e: 0.19,
    }),
    // placeholder / assembly-grouping row — excluded from the total
    line({
      id: `${variant}-assembly`, assessmentId: `assess-714-${variant}`, moduleCode: "A3", lineLabel: "— Secondary packaging assembly —",
      quantity: 0, unit: "kg", isPlaceholder: true, factorSource: "unmapped",
    }),
  ],
});

export const modelRegister6L = registerAssessment("6l", 31.5, 62.9);
export const modelRegister9L = registerAssessment("9l", 44.2, 84.1);

// ── PCF preset — ISO 14067, cradle-to-gate, A1–A3; keeps the "PCF" label ──────
export const pcfDiagnosticUnit: LcaAssessment = {
  id: "assess-715-pcf", jobId: "715", jobNumber: "J000715", clientId: "quaymed",
  assessmentType: "product", isPcf: true, name: "QMD Diagnostic Unit — Product Carbon Footprint",
  sku: "QMD-1", functionalUnitValue: 1, functionalUnitUnit: "device over service life",
  confirmedQuantity: 3.92, confirmedQuantityUnit: "kg", lifecycleBoundary: "cradle_to_gate",
  includedModules: ["A1", "A2", "A3"], standard: "ISO 14067", referenceYear: 2026, geography: "DE",
  version: 2, reviewStatus: "pending", reviewedVersion: null, totalTco2e: 0.284,
  scenarios: [],
  lines: [
    line({ id: "pcf-housing", assessmentId: "assess-715-pcf", moduleCode: "A1", lineLabel: "ABS enclosure", materialCategoryId: "mc-polymers", quantity: 2.4, unit: "kg", factorSource: "dataset", datasetId: "ds-ecoinvent-310", factorId: "f-abs", factorLabel: "ABS production, Europe", factorMatchConfidence: 0.91, dataQuality: "primary", calculatedKgco2e: 9.8 }),
    line({ id: "pcf-pcb", assessmentId: "assess-715-pcf", moduleCode: "A1", lineLabel: "Control PCB", materialCategoryId: "mc-electronics", quantity: 0.62, unit: "kg", factorSource: "dataset", datasetId: "ds-ecoinvent-310", factorId: "f-pwb", factorLabel: "Printed wiring board", factorMatchConfidence: 0.72, dataQuality: "secondary", calculatedKgco2e: 61.4 }),
    line({ id: "pcf-battery", assessmentId: "assess-715-pcf", moduleCode: "A1", lineLabel: "Lithium battery pack", materialCategoryId: "mc-electronics", quantity: 0.9, unit: "kg", factorSource: "unmapped", dataQuality: "estimated" }),
  ],
};

// ── Mass reconciliation mismatch — confirmed 31.5 kg vs captured 28.9 kg ──────
export const massReconciliationSnapshot: LcaResultSnapshot = {
  id: "lca-snap-714-6l-v3", assessmentId: "assess-714-6l", scenarioId: "scn-6l-base", assessmentVersion: 3,
  dataHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  totalTco2e: 62.9,
  moduleBreakdown: [
    { moduleCode: "A1", tco2e: 54.2 },
    { moduleCode: "A3", tco2e: 1.4 },
    { moduleCode: "A4", tco2e: 6.4 },
    { moduleCode: "C3", tco2e: 0.6 },
    { moduleCode: "C4", tco2e: 0.3 },
  ],
  hotspots: [{ lineItemId: "6l-tray", label: "rPET tray", tco2e: 52.9, sharePct: 84 }],
  massReconciliation: { confirmedMassKg: 31.5, capturedMassKg: 28.9, deltaPct: -8.25 },
};

export const lcaFidelityAssessments = [modelRegister6L, modelRegister9L, pcfDiagnosticUnit];
