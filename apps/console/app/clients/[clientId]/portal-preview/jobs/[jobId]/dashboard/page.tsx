import { redirect } from "next/navigation";
import { PreviewFrame } from "../../../PreviewFrame";
import { PortalDashboard } from "../../../../../../portal/jobs/[jobId]/PortalDashboard";
import { portalPreviewBase } from "../../../../../../portal/portalPreviewLinks";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";

export const dynamic = "force-dynamic";

/**
 * The job's dashboard as the client sees it — the client's own component, behind the client's own flag (`portal-analytics`):
 * off for clients, off here, back to the report as the client's page does. The action tracker is left out: it writes.
 */
export default async function PortalPreviewDashboardPage({ params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  const { clientId, jobId } = await params;
  if (!portalFeatureEnabled("portal-analytics")) redirect(`${portalPreviewBase(clientId)}/jobs/${encodeURIComponent(jobId)}`);
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="dashboard">
    {() => <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}><PortalDashboard jobId={jobId} /></main>}
  </PreviewFrame>;
}
