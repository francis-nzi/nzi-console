import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalDashboard } from "../PortalDashboard";
import { PortalActionTrackerPanel } from "../PortalActionTracker";
import { ShellDashboard } from "../../../shell/ShellViews";

export const dynamic = "force-dynamic";

// Client portal Phase 2 · A1 — behind `portal-analytics`. Flag off → the page
// does not exist for the client (back to the report). The dashboard draws its own header band (whose account, which year,
// the way to the report and to intensity), as MOCKUP-client-portal.html lays it out.
export default async function PortalDashboardPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-analytics")) redirect(`/portal/jobs/${jobId}`);
  if (portalFeatureEnabled("portal-shell")) return <ShellDashboard jobId={jobId} actions={portalFeatureEnabled("portal-actions")} />;
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <PortalDashboard jobId={jobId} />
      {portalFeatureEnabled("portal-actions") ? <PortalActionTrackerPanel jobId={jobId} /> : null}
    </main>
  );
}
