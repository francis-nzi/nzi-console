import Link from "next/link";
import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { PortalIntensity } from "./PortalIntensity";
import "../portal-intensity.css";

export const dynamic = "force-dynamic";

/**
 * Client portal · emissions intensity — read-only, behind `portal-analytics` like the
 * emissions dashboard. Flag off → the page does not exist for the client (back to the
 * portfolio). Nothing on this page edits anything: intensity measures are set with the
 * NZI consultant and their annual values are recorded on the job.
 */
export default function PortalIntensityPage() {
  if (!portalFeatureEnabled("portal-analytics")) redirect("/portal");
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <div className="nz-portal-section-head">
        <div>
          <span className="nz-eyebrow">Your carbon programme</span>
          <h1>Emissions intensity</h1>
          <p>How your assured emissions compare against the measures that matter to your business.</p>
        </div>
        <Link className="nz-btn" href="/portal">Back to your engagements</Link>
      </div>
      <PortalIntensity />
    </main>
  );
}
