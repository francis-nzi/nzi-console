import { redirect } from "next/navigation";
import { PreviewFrame } from "../../../PreviewFrame";
import { PortalMetrics } from "../../../../../../portal/metrics/PortalMetrics";
import { portalPreviewBase } from "../../../../../../portal/portalPreviewLinks";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";

export const dynamic = "force-dynamic";

/** Metrics as the client sees them — read through the preview's mirror of the dashboard and published-report reads (#506). */
export default async function PortalPreviewMetricsPage({ params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  const { clientId, jobId } = await params;
  if (!portalFeatureEnabled("portal-analytics")) redirect(`${portalPreviewBase(clientId)}/jobs/${encodeURIComponent(jobId)}`);
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="metrics">
    {() => <PortalMetrics jobId={jobId} />}
  </PreviewFrame>;
}
