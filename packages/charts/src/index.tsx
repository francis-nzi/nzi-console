// @nzi/charts — one SVG-first chart engine for every surface (screen · PDF · portal).
// See docs/GRAPHICS_PIPELINE.md and docs/ARCHITECTURE.md §7.

export { EmissionsScopeDonut, formatDate } from "./EmissionsScopeDonut";
export { ReductionPathway } from "./ReductionPathway";
export { ScopeYearOnYearBar } from "./ScopeYearOnYearBar";
export { EmissionsByActivity } from "./EmissionsByActivity";
export { ManifestChartSet } from "./ManifestChartSet";
export { EmissionsSiteDonut } from "./EmissionsSiteDonut";
export { IntensityPathway } from "./IntensityPathway";
export { PurchasedGoodsBreakdown } from "./PurchasedGoodsBreakdown";
export { LcaStageBar } from "./LcaStageBar";
export { TrainingAttendance } from "./TrainingAttendance";

export * from "./types";
export { tokens, TOKENS_VERSION, scopeColor, siteColor, readableInkOn } from "./tokens";
export { RENDERER_VERSION, chartAssetKey } from "./identity";
export type { RenderTarget } from "./identity";
export { validateManifest, assertPublishable } from "./manifest";
export type { ReportManifest, ReportManifestSection, ManifestValidation, ManifestIssue } from "./manifest";
export { CRP_RESOLVER_VERSION, crpProfessionalManifest, resolveCrpCharts,resolveCrpCoreCharts } from "./crp";
export type { ReviewedCrpSnapshot, ReviewedCrpSnapshotCore,ReviewedScopeMeasurement } from "./crp";
export {
  reviewedCrpSnapshotSample,
  scopeDonutSample,
  reductionPathwaySample,
  scopeYearOnYearSample,
  emissionsByActivitySample,
  emissionsSiteDonutSample,
  intensityPathwaySample,
  purchasedGoodsBreakdownSample,
  crpChartSamples,
} from "./sample";
