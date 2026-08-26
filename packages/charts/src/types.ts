export type JobFamily = "crp" | "lca" | "pcf" | "training" | "consultancy";
export type ChartState = "success" | "empty" | "degraded" | "failed";
export type ChartType = "emissions_scope_donut" | "emissions_site_donut" | "reduction_pathway" | "scope_year_on_year_bar" | "emissions_by_activity" | "purchased_goods_breakdown" | "intensity_pathway" | "lca_stage_bar" | "training_attendance";
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
export type ScopeYearValue = { scope: "1" | "2" | "3"; value: number };
export type ScopeYearGroup = { year: number; values: ScopeYearValue[] };
export type ScopeYearOnYearData = ChartEnvelope & { years: ScopeYearGroup[] };
export type ActivityBar = { id: string; label: string; scope: "1" | "2" | "3"; value: number };
export type EmissionsByActivityData = ChartEnvelope & { activities: ActivityBar[] };
export type SiteSegment = { id: string; label: string; value: number };
export type SiteDonutData = ChartEnvelope & { sites: SiteSegment[]; total?: number };
export type IntensityPathwayData = ReductionPathwayData & { metric: "turnover" | "employee" | "floor-area" };
export type PurchasedGoodsBreakdownData = EmissionsByActivityData & { basis: "category" | "supplier" };
export type LcaStageValue = { id: string; label: string; value: number; status?: "modelled" | "provisional" };
export type LcaStageBarData = ChartEnvelope & { stages: LcaStageValue[]; functionalUnit: string };
export type TrainingAttendanceValue = { id: string; label: string; invited: number; attended: number; completed: number };
export type TrainingAttendanceData = ChartEnvelope & { cohorts: TrainingAttendanceValue[] };
export type AnyChartData = ScopeDonutData | SiteDonutData | ReductionPathwayData | IntensityPathwayData | ScopeYearOnYearData | EmissionsByActivityData | PurchasedGoodsBreakdownData | LcaStageBarData | TrainingAttendanceData;
