// Job-family model batch, Phase 0 — contract types for the non-CRP families
// (NZC-052–056; MODEL_FIDELITY_JOB_FAMILIES.md). Types only for now — the read
// models and commands land with each family's workspace module. LCA/PCF first;
// Training and Consultancy types are added by their own migrations.

// ── LCA / PCF ─────────────────────────────────────────────────────────────────

/** EN 15804 life-cycle module code. */
export type LcaModuleCode =
  | "A1" | "A2" | "A3" | "A4" | "A5"
  | "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7"
  | "C1" | "C2" | "C3" | "C4" | "D";

export type LcaModuleGroup = "product" | "transport" | "use" | "end_of_life" | "benefits";

export type LcaModule = {
  code: LcaModuleCode;
  label: string;
  group: LcaModuleGroup;
  sortOrder: number;
  defaultInPcf: boolean;
  defaultInLca: boolean;
};

export type LcaAssessmentType = "product" | "service";
export type LcaLifecycleBoundary = "cradle_to_gate" | "cradle_to_grave" | "custom";
export type LcaReviewStatus = "pending" | "approved" | "rejected";
export type LcaDataQuality = "primary" | "secondary" | "proxy" | "estimated";
export type LcaFactorSource = "dataset" | "client" | "manual" | "unmapped";
export type LcaEndOfLifeRoute = "landfill" | "recycling" | "incineration" | "compost" | "reuse" | "other";
export type LcaTransportMode = "road_hgv" | "road_van" | "rail" | "sea" | "air" | "inland_water" | "other";

/** A reusable, client-scoped (or global) component library entry. */
export type LcaComponent = {
  id: string;
  clientId: string | null;
  componentCode: string | null;
  description: string;
  materialCategoryId: string | null;
  defaultUnitMass: number | null;
  defaultUnit: string;
  originCountry: string | null;
  supplierName: string | null;
  archived: boolean;
};

export type LcaTransportLeg = {
  id: string;
  legOrder: number;
  fromLabel: string;
  toLabel: string;
  mode: LcaTransportMode;
  distanceKm: number;
  distanceSource: "geocoded" | "manual";
  factorSource: LcaFactorSource;
  calculatedKgco2e: number | null;
};

export type LcaLineItem = {
  id: string;
  assessmentId: string;
  componentId: string | null;
  moduleCode: LcaModuleCode;
  lineLabel: string;
  materialCategoryId: string | null;
  quantity: number;
  unit: string;
  originCountry: string | null;
  energyKwh: number | null;
  endOfLifeRoute: LcaEndOfLifeRoute | null;
  factorSource: LcaFactorSource;
  datasetId: string | null;
  factorId: string | null;
  clientFactorId: string | null;
  factorValue: number | null;
  factorLabel: string | null;
  factorMatchConfidence: number | null;
  dataQuality: LcaDataQuality;
  isGapFilled: boolean;
  gapFillMethod: string | null;
  /** an assembly-grouping / zero-weight row — excluded from the calculation */
  isPlaceholder: boolean;
  transportKgco2e: number;
  calculatedKgco2e: number | null;
  transportLegs: LcaTransportLeg[];
};

export type LcaScenario = {
  id: string;
  name: string;
  isBaseline: boolean;
  multipliers: Array<{ moduleCode: LcaModuleCode; materialCategoryId: string | null; componentId: string | null; multiplier: number }>;
};

/** Content-addressed calculation output — the reviewed artefact an LCA report cites. */
export type LcaResultSnapshot = {
  id: string;
  assessmentId: string;
  scenarioId: string | null;
  assessmentVersion: number;
  dataHash: string;
  totalTco2e: number;
  moduleBreakdown: Array<{ moduleCode: LcaModuleCode; tco2e: number }>;
  hotspots: Array<{ lineItemId: string; label: string; tco2e: number; sharePct: number }>;
  massReconciliation: { confirmedMassKg: number | null; capturedMassKg: number; deltaPct: number | null };
};

export type LcaAssessment = {
  id: string;
  jobId: string;
  jobNumber: string;
  clientId: string | null;
  assessmentType: LcaAssessmentType;
  /** "PCF" when standard is ISO 14067 + cradle-to-gate; UI keeps the "Product Carbon Footprint" label (NZC-039). */
  isPcf: boolean;
  name: string;
  sku: string | null;
  functionalUnitValue: number;
  functionalUnitUnit: string;
  confirmedQuantity: number | null;
  confirmedQuantityUnit: string;
  lifecycleBoundary: LcaLifecycleBoundary;
  includedModules: LcaModuleCode[];
  standard: string;
  referenceYear: number | null;
  geography: string | null;
  version: number;
  reviewStatus: LcaReviewStatus;
  reviewedVersion: number | null;
  totalTco2e: number;
  lines: LcaLineItem[];
  scenarios: LcaScenario[];
};
