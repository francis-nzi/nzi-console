import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalInsights } from "../../../insights/PortalInsights";
import { PortalShellClient } from "../../../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/** Insights & Help (BUILD-portal-shell-lookandfeel, Support): from the job's assured figures. A shell view only. */
export default async function PortalInsightsPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-shell")) redirect("/portal");
  return <PortalShellClient view="insights" jobId={jobId}><PortalInsights jobId={jobId} /></PortalShellClient>;
}
