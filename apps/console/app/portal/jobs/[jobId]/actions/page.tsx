import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalReductionPlan } from "../../../PortalReductionPlan";
import { PortalActionTrackerPanel } from "../PortalActionTracker";
import { PortalShellClient } from "../../../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/**
 * Actions (BUILD-portal-shell-lookandfeel R2 — the mockup's "Strategy"): the client's reduction plan, and this job's Spheres of
 * Influence action tracker under it. A shell view only: with `portal-shell` off the plan stays on the old home, as before.
 */
export default async function PortalActionsPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-shell") || !portalFeatureEnabled("portal-plan")) redirect("/portal");
  return <PortalShellClient view="actions" jobId={jobId}>
    <PortalReductionPlan />
    {portalFeatureEnabled("portal-actions") ? <PortalActionTrackerPanel jobId={jobId} /> : null}
  </PortalShellClient>;
}
