import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalMetrics } from "../../../metrics/PortalMetrics";
import { PortalShellClient } from "../../../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/** Metrics (BUILD-portal-shell-lookandfeel R8): the job's assured figures, filterable and re-formattable. A shell view only. */
export default async function PortalMetricsPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-shell") || !portalFeatureEnabled("portal-analytics")) redirect("/portal");
  return <PortalShellClient view="metrics" jobId={jobId}><PortalMetrics jobId={jobId} /></PortalShellClient>;
}
