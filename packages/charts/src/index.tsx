// @nzi/charts — one SVG-first chart engine for every surface (screen · PDF · portal).
// See docs/GRAPHICS_PIPELINE.md and docs/ARCHITECTURE.md §7.

export { EmissionsScopeDonut, formatDate } from "./EmissionsScopeDonut";
export { ReductionPathway } from "./ReductionPathway";
export { ScopeYearOnYearBar } from "./ScopeYearOnYearBar";
export { EmissionsByActivity } from "./EmissionsByActivity";
export { ManifestChartSet, PrintSafeBadge } from "./ManifestChartSet";
export { EmissionsSiteDonut } from "./EmissionsSiteDonut";
export { IntensityPathway } from "./IntensityPathway";
export { PurchasedGoodsBreakdown } from "./PurchasedGoodsBreakdown";
export { LcaStageBar } from "./LcaStageBar";
export { LcaModuleDonut } from "./LcaModuleDonut";
export { LcaHotspotsBar } from "./LcaHotspotsBar";
export { TrainingAttendance } from "./TrainingAttendance";

export * from "./types";
export { tokens, TOKENS_VERSION, scopeColor, siteColor, moduleGroupColor, readableInkOn } from "./tokens";
export { RENDERER_VERSION, chartAssetKey } from "./identity";
export type { RenderTarget } from "./identity";
export { validateManifest, assertPublishable } from "./manifest";
export { verifyChartsAgainstSnapshot, verifyLcaChartsAgainstSnapshot } from "./verify";
export type { ChartVerification, ChartFigureCheck, VerifiableSnapshot, VerifiableLcaSnapshot } from "./verify";
export type { ReportManifest, ReportManifestSection, ManifestValidation, ManifestIssue } from "./manifest";
export { CRP_RESOLVER_VERSION, crpProfessionalManifest, resolveCrpCharts,resolveCrpCoreCharts } from "./crp";
export type { ReviewedCrpSnapshot, ReviewedCrpSnapshotCore,ReviewedScopeMeasurement } from "./crp";
export { LCA_RESOLVER_VERSION, lcaProfessionalManifest, pcfProfessionalManifest, resolveLcaCharts, resolveLcaChartSet } from "./lca";
export type { ReviewedLcaSnapshot } from "./lca";
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
  reviewedLcaSnapshotSample,
  lcaModuleDonutSample,
  lcaHotspotsBarSample,
  lcaChartSamples,
} from "./sample";
