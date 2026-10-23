import { redirect } from "next/navigation";
import { PreviewFrame } from "../../../PreviewFrame";
import { PortalDataView } from "../../../../../../portal/jobs/[jobId]/data/PortalDataView";
import { portalPreviewBase } from "../../../../../../portal/portalPreviewLinks";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";

export const dynamic = "force-dynamic";

/**
 * The job's Data view as the client sees it — the client's own component, narrowed by the client's portal profile, behind the
 * client's own flag (`portal-data`). Read-only (R5): no entry, no change, no deactivation is drawn.
 */
export default async function PortalPreviewDataPage({ params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  const { clientId, jobId } = await params;
  if (!portalFeatureEnabled("portal-data")) redirect(`${portalPreviewBase(clientId)}/jobs/${encodeURIComponent(jobId)}`);
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="data">
    {() => <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}><PortalDataView jobId={jobId} /></main>}
  </PreviewFrame>;
}
