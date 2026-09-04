// Per-slice flags for the Report Studio redesign (docs/REPORT_PRINTING_UX.md §6;
// docs/REDESIGN_ROLLOUT.md "M7 · Report Studio"). Same discipline as the
// data-entry adapters: each slice ships behind its own flag, OFF by default, with
// the current report path as default until the slice passes its acceptance.
//
//   NEXT_PUBLIC_FEATURE_REPORT_STUDIO=report-svg-charts
//   NEXT_PUBLIC_FEATURE_REPORT_STUDIO=report-svg-charts,report-sections
//
// Resolved from one NEXT_PUBLIC_* variable so server and client agree across
// render boundaries. NEXT_PUBLIC_* is inlined at `next build` — a flip is a
// Render dashboard edit + rebuild (see docs/DEPLOYMENT.md §"Feature-flag flips").

export type ReportFeature =
  | "report-svg-charts"
  | "report-sections"
  | "report-tokens"
  | "report-edit"
  | "report-paged";

const enabledFeatures = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_FEATURE_REPORT_STUDIO ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

export function reportFeatureEnabled(feature: ReportFeature): boolean {
  return enabledFeatures().has(feature);
}
