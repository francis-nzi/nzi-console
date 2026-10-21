import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { PortalReports } from "./PortalReports";

export const dynamic = "force-dynamic";

// Client portal — the Reports view (BUILD-client-portal-reports), behind `portal-reports`. Flag off → the page does not exist for
// the client (back to the portfolio).
export default function PortalReportsPage() {
  if (!portalFeatureEnabled("portal-reports")) redirect("/portal");
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <PortalReports />
    </main>
  );
}
