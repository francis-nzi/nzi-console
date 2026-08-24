// @nzi/charts — typed chart contracts
//
// Every chart is a pure function of (reviewed data + spec + tokens). Data carries
// its own provenance so a chart is as evidence-backed as a scope row, and the same
// data object renders identically to screen, PDF and portal. See docs/GRAPHICS_PIPELINE.md.

export type JobFamily = "crp" | "lca" | "pcf" | "training" | "consultancy";

export type ChartType =
  | "emissions_scope_donut"
  | "reduction_pathway"
  | "emissions_by_activity"
  | "intensity_pathway";

/** Where the numbers came from — travels with the chart everywhere it is shown. */
export type Provenance = {
  jobId: string;
  /** Hash of the resolved data; the content-address key for any cache. */
  dataHash: string;
  /** e.g. ["DEFRA 2024 v1.2", "DESNZ 2024 v1.0", "CEDA 2025 v1.0"] */
  factorSets: string[];
  /** ISO timestamp the data was resolved (never Date.now() inside a render). */
  generatedAt: string;
  /** Optional dominant data-quality tier for the chart as a whole. */
  quality?: DataQuality;
};

export type DataQuality = "Measured" | "Estimated" | "Spend-based" | "Survey";

export type ChartSpec = {
  /** Stable widget id, e.g. "emissions_scope_donut". */
  id: string;
  type: ChartType;
  title: string;
  subtitle?: string;
  family: JobFamily;
  /** Bumped when the visual definition changes — part of the cache key. */
  specVersion: number;
};

/** Shared envelope every chart data object extends. */
export type ChartEnvelope = {
  spec: ChartSpec;
  unit: string; // e.g. "tCO₂e"
  provenance: Provenance;
};

// ---- emissions_scope_donut -------------------------------------------------

export type ScopeSegment = {
  /** GHG Protocol scope, e.g. "1", "2", "3" (or "3.4" — colour resolves on the leading digit). */
  scope: string;
  label: string;
  value: number;
  /** Optional explicit colour; otherwise resolved from the brand scope palette. */
  color?: string;
};

export type ScopeDonutData = ChartEnvelope & {
  segments: ScopeSegment[];
  /** Optional override of the centre total; defaults to the sum of segments. */
  total?: number;
};

// ---- reduction_pathway -----------------------------------------------------

export type YearPoint = { year: number; value: number };

export type PathwayMilestone = {
  year: number;
  value: number;
  label: string;
  kind: "baseline" | "interim" | "netzero";
};

export type ReductionPathwayData = ChartEnvelope & {
  /** Measured/estimated emissions to date, oldest → newest (includes the baseline year). */
  actual: YearPoint[];
  /** The required target trajectory: baseline → interim → net zero. */
  target: YearPoint[];
  /** Points to annotate directly (baseline, interim target, net-zero target). */
  milestones: PathwayMilestone[];
};

export type AnyChartData = ScopeDonutData | ReductionPathwayData;
