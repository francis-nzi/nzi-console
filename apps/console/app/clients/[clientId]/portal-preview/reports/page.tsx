import { redirect } from "next/navigation";
import { PreviewFrame } from "../PreviewFrame";
import { PortalReports } from "../../../../portal/reports/PortalReports";
import { portalPreviewBase } from "../../../../portal/portalPreviewLinks";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";

export const dynamic = "force-dynamic";

/**
 * The client's Reports index as the client sees it, across the client's own jobs (R3) — behind the client's own flag
 * (`portal-reports`). There is no approving from it (R5), and no download.
 */
export default async function PortalPreviewReportsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!portalFeatureEnabled("portal-reports")) redirect(portalPreviewBase(clientId));
  return <PreviewFrame clientId={clientId} surface="reports">
    {() => <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}><PortalReports /></main>}
  </PreviewFrame>;
}
