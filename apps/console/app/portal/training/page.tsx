import Link from "next/link";
import { PortalTraining } from "./PortalTraining";

export const dynamic = "force-dynamic";

/**
 * Client portal · training — read-only. Unlike the analytics pages this is not behind
 * `portal-analytics`: it shows what the client has already bought and what their people
 * have already done, neither of which depends on an assured report being published.
 *
 * The page holds no client identity of its own. Whose training this is comes from the
 * session, resolved server-side in `/api/portal/training`; there is no client in the URL
 * to change.
 */
export default function PortalTrainingPage() {
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <div className="nz-portal-section-head">
        <div>
          <span className="nz-eyebrow">Your team</span>
          <h1>Training</h1>
          <p>
            Everything your people have trained on with NZI, and the training places you hold. Places do not
            last forever, so this page shows what is still available and when it expires.
          </p>
        </div>
        <Link className="nz-btn" href="/portal">Back to your engagements</Link>
      </div>
      <PortalTraining />
    </main>
  );
}
