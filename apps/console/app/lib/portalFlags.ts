// Client portal Phase 2 feature flags. Own NEXT_PUBLIC_* variable, parallel to
// the data-entry / report-studio flag sets. Build-time inlined — a flip is a
// Render dashboard edit + Clear build cache & deploy. Unset = every flag OFF.
//
//   NEXT_PUBLIC_FEATURE_PORTAL=portal-analytics
//
// `portal-plan` and `portal-readiness` were added retrospectively (NZC-080). Both surfaces
// shipped without a gate, which left no way to withdraw either short of a revert — the one
// thing a flag exists to provide. Both tokens are set in the dashboard, so adding the gate
// changes nothing about what a client sees today.
export type PortalFeature =
  | "portal-analytics"
  | "portal-actions"
  | "portal-plan"
  | "portal-readiness"
  | "portal-reports"
  // Portal data-entry phase 1: the staff Portal Management area. Ships dark — off until the token is added to
  // NEXT_PUBLIC_FEATURE_PORTAL (portal-dataentry-phase1-GROUNDING, point 2).
  | "portal-management"
  // Portal data-entry phase 2: the client's Data view on the shared scope rows. Ships dark: off until the token is added to
  // NEXT_PUBLIC_FEATURE_PORTAL, in the dashboard and in render.yaml in the same change (#503). While it is off the records
  // path is the client's data entry; once on, the records path stops taking new entries, so there is no gap either way.
  | "portal-data";

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
