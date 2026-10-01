import Link from "next/link";
import { PortalTraining } from "./PortalTraining";
import { deploymentNames } from "../../lib/organisationBrand";
import { organisationCopy } from "../../lib/organisationName";

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
export default async function PortalTrainingPage() {
  const org = organisationCopy(await deploymentNames());
  return (
    <main className="nz-portal-shell" id="portal-main-content" tabIndex={-1}>
      <div className="nz-portal-section-head">
        <div>
          <span className="nz-eyebrow">Your team</span>
          <h1>Training</h1>
          <p>
            Everything your people have trained on with {org.short}, and the training places you hold. Places do not
            last forever, so this page shows what is still available and when it expires.
          </p>
        </div>
        <Link className="nz-btn" href="/portal">Back to your jobs</Link>
      </div>
      <PortalTraining />
    </main>
  );
}
