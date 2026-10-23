import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalDataView } from "./PortalDataView";
import { PortalShellClient } from "../../../shell/PortalShellClient";

export const dynamic = "force-dynamic";

// Portal data-entry phase 2 — the client's Data view, behind `portal-data` (dark by absence). Flag off → the page does not
// exist for the client (back to the job).
export default async function PortalDataPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-data")) redirect(`/portal/jobs/${jobId}`);
  if (portalFeatureEnabled("portal-shell")) return <PortalShellClient view="data" jobId={jobId}><PortalDataView jobId={jobId} /></PortalShellClient>;
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <PortalDataView jobId={jobId} />
    </main>
  );
}
