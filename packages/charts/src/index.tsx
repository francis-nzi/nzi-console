// @nzi/charts — one SVG-first chart engine for every surface (screen · PDF · portal).
// See docs/GRAPHICS_PIPELINE.md and docs/ARCHITECTURE.md §7.

export { EmissionsScopeDonut, formatDate } from "./EmissionsScopeDonut";
export { ReductionPathway } from "./ReductionPathway";
export { ScopeYearOnYearBar } from "./ScopeYearOnYearBar";
export { EmissionsByActivity } from "./EmissionsByActivity";

export * from "./types";
export { tokens, TOKENS_VERSION, scopeColor, readableInkOn } from "./tokens";
export { RENDERER_VERSION, chartAssetKey } from "./identity";
export type { RenderTarget } from "./identity";
export { validateManifest, assertPublishable } from "./manifest";
export type { ReportManifest, ManifestValidation, ManifestIssue } from "./manifest";
export { CRP_RESOLVER_VERSION, crpProfessionalManifest, resolveCrpCharts } from "./crp";
export type { ReviewedCrpSnapshot, ReviewedScopeMeasurement } from "./crp";
export {
  reviewedCrpSnapshotSample,
  scopeDonutSample,
  reductionPathwaySample,
  scopeYearOnYearSample,
  emissionsByActivitySample,
} from "./sample";
