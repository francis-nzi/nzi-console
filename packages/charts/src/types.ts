export type JobFamily = "crp" | "lca" | "pcf" | "training" | "consultancy";
export type ChartState = "success" | "empty" | "degraded" | "failed";
export type ChartType = "emissions_scope_donut" | "emissions_site_donut" | "reduction_pathway" | "scope_year_on_year_bar" | "emissions_by_activity" | "purchased_goods_breakdown" | "intensity_pathway" | "intensity_bases_indexed" | "lca_stage_bar" | "lca_module_donut" | "lca_hotspots_bar" | "training_attendance" | "srs_pillar_radar" | "srs_maturity_bullets" | "srs_gap_heatmap" | "srs_readiness_trend";
export type LcaModuleGroup = "product" | "transport" | "use" | "end_of_life" | "benefits";
import type { ProvenanceSignature, QualityTier } from "@nzi/contracts";
export type DataQuality = QualityTier;

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
  signature?: ProvenanceSignature;
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
/**
 * Intensity on several bases at once. Each basis has its own denominator, unit and
 * scale, so they can only share an axis once indexed to a common base year (= 100).
 * `points` carries the indexed value; `absolute` keeps the real figure for the tooltip.
 */
export type IndexedBasisPoint = YearPoint & { absolute: number; absoluteUnit: string };
export type IndexedBasisSeries = { key: "turnover" | "employee" | "floor-area"; label: string; points: IndexedBasisPoint[] };
/** `baseYear` null = no year resolves on every basis, so each is indexed to its own first year. */
export type IntensityBasesIndexedData = ChartEnvelope & { baseYear: number | null; series: IndexedBasisSeries[] };
export type PurchasedGoodsBreakdownData = EmissionsByActivityData & { basis: "category" | "supplier" };
export type LcaStageValue = { id: string; label: string; value: number; status?: "modelled" | "provisional" };
export type LcaStageBarData = ChartEnvelope & { stages: LcaStageValue[]; functionalUnit: string };
export type LcaModuleSegment = { code: string; label: string; group: LcaModuleGroup; value: number };
export type LcaModuleDonutData = ChartEnvelope & { modules: LcaModuleSegment[]; total?: number; functionalUnit: string };
export type LcaHotspot = { id: string; label: string; group: LcaModuleGroup; value: number; sharePct: number };
export type LcaHotspotsBarData = ChartEnvelope & { hotspots: LcaHotspot[]; functionalUnit: string };
export type TrainingAttendanceValue = { id: string; label: string; invited: number; attended: number; completed: number };
export type TrainingAttendanceData = ChartEnvelope & { cohorts: TrainingAttendanceValue[] };

/**
 * SRS readiness (Aotearoa NZ Climate Standards / sustainability reporting readiness).
 * Maturity is an ordinal level 0–`maxLevel` (0 not started → 4 assured), never a
 * quantity — so it is drawn on the sequential `tokens.srs.maturity` ramp. The scope
 * palette is reserved for GHG scope identity and never appears on these charts.
 */
export type SrsStandardKey = "S1" | "S2";
export type SrsPillarSeries = { key: SrsStandardKey; label: string; values: number[] };
export type SrsPillarRadarData = ChartEnvelope & { pillars: string[]; series: SrsPillarSeries[]; target: number[]; maxLevel: number };
export type SrsMaturityRow = { label: string; value: number; valueLabel: string; comparison: number | null; target: number };
export type SrsMaturityBulletsData = ChartEnvelope & { rows: SrsMaturityRow[]; maxLevel: number };
export type SrsGapRow = { label: string; value: number; target: number };
export type SrsGapGroup = { label: string; rows: SrsGapRow[] };
export type SrsGapHeatmapData = ChartEnvelope & { levels: string[]; groups: SrsGapGroup[] };
export type SrsReadinessPoint = { label: string; value: number };
export type SrsReadinessTrendData = ChartEnvelope & { points: SrsReadinessPoint[] };

export type AnyChartData = ScopeDonutData | SiteDonutData | ReductionPathwayData | IntensityPathwayData | IntensityBasesIndexedData | ScopeYearOnYearData | EmissionsByActivityData | PurchasedGoodsBreakdownData | LcaStageBarData | LcaModuleDonutData | LcaHotspotsBarData | TrainingAttendanceData | SrsPillarRadarData | SrsMaturityBulletsData | SrsGapHeatmapData | SrsReadinessTrendData;
