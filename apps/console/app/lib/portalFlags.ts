// Client portal Phase 2 feature flags. Own NEXT_PUBLIC_* variable, parallel to
// the data-entry / report-studio flag sets. Build-time inlined — a flip is a
// Render dashboard edit + Clear build cache & deploy. Unset = every flag OFF.
//
//   NEXT_PUBLIC_FEATURE_PORTAL=portal-analytics
export type PortalFeature = "portal-analytics";

const enabled = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_FEATURE_PORTAL ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

export function portalFeatureEnabled(feature: PortalFeature): boolean {
  return enabled().has(feature);
}
