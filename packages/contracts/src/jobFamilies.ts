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
/** Canonical list (seeded 1:1 by migration 0045) — for validation, without a DB round-trip. */
export const lcaModuleCodes: readonly LcaModuleCode[] = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "C1", "C2", "C3", "C4", "D"];

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

/** Canonical list — for validation without a DB round-trip. */
export const lcaTransportModes: readonly LcaTransportMode[] = ["road_hgv", "road_van", "rail", "sea", "air", "inland_water", "other"];

/**
 * Freight default factor shortlist per transport mode
 * (docs/_handoff_LCA_engine_parity.md §8). Factor ids match the live app's
 * cross-dataset `original_id`s — resolved against the job's active dataset at
 * lookup time, never hardcoded to a dataset/year. Free-text search stays
 * available alongside for anything unusual.
 */
export const freightDefaultFactorIds: Partial<Record<LcaTransportMode, ReadonlyArray<{ factorId: string; label: string }>>> = {
  road_van: [{ factorId: "27_303_3102_14_1", label: "Van (up to 3.5t) Diesel" }],
  road_hgv: [
    { factorId: "27_304_3140_14_1", label: "HGV (All Diesel), Average Laden" },
    { factorId: "27_306_3140_14_1", label: "HGV Refrigerated (All Diesel), Average Laden" },
  ],
  rail: [{ factorId: "27_315_3151_14_1", label: "Freight Train" }],
  sea: [
    { factorId: "27_319_3197_14_1", label: "Tanker — Crude" },
    { factorId: "27_319_3208_14_1", label: "Tanker — Chemical" },
    { factorId: "27_319_3211_14_1", label: "Tanker — LNG" },
    { factorId: "27_319_3214_14_1", label: "Tanker — LPG" },
    { factorId: "27_320_3221_14_1", label: "Cargo Ship — Bulk Carrier" },
    { factorId: "27_320_3228_14_1", label: "Cargo Ship — General Cargo" },
    { factorId: "27_320_3235_14_1", label: "Cargo Ship — Container Ship" },
  ],
  air: [
    { factorId: "27_317_3152_14_1", label: "Freight Flight — Domestic (to/from UK)" },
    { factorId: "27_317_3154_14_1", label: "Freight Flight — Short-Haul (to/from UK)" },
    { factorId: "27_317_3158_14_1", label: "Freight Flight — International (to/from non-UK)" },
  ],
};

export type LcaTransportLeg = {
  id: string;
  legOrder: number;
  fromLabel: string;
  fromLat: number | null;
  fromLng: number | null;
  toLabel: string;
  toLat: number | null;
  toLng: number | null;
  mode: LcaTransportMode;
  distanceKm: number;
  distanceSource: "geocoded" | "manual";
  /** No `client_factor_id` column on this table (unlike line items) — 'client' is not a valid source here. */
  factorSource: Exclude<LcaFactorSource, "client">;
  datasetId: string | null;
  factorId: string | null;
  factorValue: number | null;
  calculatedKgco2e: number | null;
  notes: string;
};

/** The editable fields of a transport leg — `lca.transportLeg.create` / `.update` (L3). */
export type LcaTransportLegWriteFields = {
  fromLabel: string;
  fromLat?: number | null;
  fromLng?: number | null;
  toLabel: string;
  toLat?: number | null;
  toLng?: number | null;
  mode: LcaTransportMode;
  distanceKm: number;
  distanceSource?: "geocoded" | "manual";
  factorSource?: Exclude<LcaFactorSource, "client">;
  datasetId?: string | null;
  factorId?: string | null;
  factorValue?: number | null;
  notes?: string;
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
  factorUnit: string | null;
  factorLabel: string | null;
  factorMatchConfidence: number | null;
  dataQuality: LcaDataQuality;
  isGapFilled: boolean;
  gapFillMethod: string | null;
  /** an assembly-grouping / zero-weight row — excluded from the calculation */
  isPlaceholder: boolean;
  transportKgco2e: number;
  calculatedKgco2e: number | null;
  notes: string;
  transportLegs: LcaTransportLeg[];
};

/** The editable fields of a line item — `lca.lineItem.create` / `.update` (NZC-054/056). */
export type LcaLineItemWriteFields = {
  componentId?: string | null;
  moduleCode: LcaModuleCode;
  lineLabel: string;
  materialCategoryId?: string | null;
  quantity: number;
  unit: string;
  originCountry?: string | null;
  energyKwh?: number | null;
  endOfLifeRoute?: LcaEndOfLifeRoute | null;
  factorSource?: LcaFactorSource;
  datasetId?: string | null;
  factorId?: string | null;
  clientFactorId?: string | null;
  factorValue?: number | null;
  factorUnit?: string | null;
  factorLabel?: string | null;
  dataQuality?: LcaDataQuality;
  isPlaceholder?: boolean;
  notes?: string;
};

/** A reusable, client-scoped (or global) component library entry, for search/pick (mirrors ClientFactorRecord). */
export type LcaComponentOption = {
  id: string;
  clientId: string | null;
  componentCode: string | null;
  description: string;
  materialCategoryId: string | null;
  materialCategoryLabel: string | null;
  defaultUnitMass: number | null;
  defaultUnit: string;
  originCountry: string | null;
  supplierName: string | null;
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
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewerNote: string | null;
  totalTco2e: number;
  lastCalculatedAt: string | null;
  lines: LcaLineItem[];
  scenarios: LcaScenario[];
};

/** The editable fields of a gap-fill — `lca.lineItem.gapFill` (L4; "the LCA analogue of the Data Assurance gate"). */
export type LcaGapFillWriteFields = {
  factorValue: number;
  factorUnit?: string | null;
  gapFillMethod: string;
  dataQuality?: LcaDataQuality;
};

/** The editable fields of an assessment — `lca.assessment.create` / `.update` (NZC-055). */
export type LcaAssessmentWriteFields = {
  assessmentType: LcaAssessmentType;
  name: string;
  sku?: string | null;
  description?: string;
  functionalUnitValue: number;
  functionalUnitUnit: string;
  confirmedQuantity?: number | null;
  confirmedQuantityUnit?: string;
  lifecycleBoundary: LcaLifecycleBoundary;
  includedModules: LcaModuleCode[];
  standard?: string;
  referenceYear?: number | null;
  geography?: string | null;
  assumptions?: string;
  dataSourcesNote?: string;
};
