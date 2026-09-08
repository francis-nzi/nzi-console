import Link from "next/link";
import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalDashboard } from "../PortalDashboard";
import { PortalActionTrackerPanel } from "../PortalActionTracker";

export const dynamic = "force-dynamic";

// Client portal Phase 2 · A1 — behind `portal-analytics`. Flag off → the page
// does not exist for the client (back to the report).
export default async function PortalDashboardPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-analytics")) redirect(`/portal/jobs/${jobId}`);
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <div className="nz-portal-section-head">
        <div>
          <span className="nz-eyebrow">Your carbon programme</span>
          <h1>Emissions dashboard</h1>
          <p>Your headline figures, straight from your latest assured report.</p>
        </div>
        <Link className="nz-btn" href={`/portal/jobs/${jobId}`}>Open the full report →</Link>
      </div>
      <PortalDashboard jobId={jobId} />
      {portalFeatureEnabled("portal-actions") ? <PortalActionTrackerPanel jobId={jobId} /> : null}
    </main>
  );
}
