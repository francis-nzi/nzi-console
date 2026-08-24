export type JobFamily = "crp" | "lca" | "pcf" | "training" | "consultancy";
export type ChartState = "success" | "empty" | "degraded" | "failed";
export type ChartType = "emissions_scope_donut" | "reduction_pathway" | "emissions_by_activity" | "intensity_pathway";
export type DataQuality = "Measured" | "Estimated" | "Spend-based" | "Survey";

export type Provenance = {
  jobId: string;
  dataHash: string;
  factorSets: string[];
  generatedAt: string;
  reviewedSnapshotId: string;
  resolverVersion: number;
  tokensVersion: number;
  rendererVersion: number;
  quality?: DataQuality;
};

export type ChartSpec = {
  id: string;
  type: ChartType;
  title: string;
  subtitle?: string;
  family: JobFamily;
  specVersion: number;
};

export type ChartEnvelope = {
  spec: ChartSpec;
  unit: string;
  provenance: Provenance;
  state: ChartState;
  stateMessage?: string;
};

export type ScopeSegment = { scope: string; label: string; value: number };
export type ScopeDonutData = ChartEnvelope & { segments: ScopeSegment[]; total?: number };
export type YearPoint = { year: number; value: number };
export type PathwayMilestone = { year: number; value: number; label: string; kind: "baseline" | "interim" | "netzero" };
export type ReductionPathwayData = ChartEnvelope & { actual: YearPoint[]; target: YearPoint[]; milestones: PathwayMilestone[] };
export type AnyChartData = ScopeDonutData | ReductionPathwayData;
