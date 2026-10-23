import { redirect } from "next/navigation";
import type { PortalPreviewReadModel } from "@nzi/isolated-backend";
import { PreviewFrame } from "./PreviewFrame";
import { PortalPreview } from "./PortalPreview";
import { portalFeatureEnabled } from "../../../lib/portalFlags";
import { defaultShellJob } from "../../../portal/shell/shellNav";
import { portalPreviewBase } from "../../../portal/portalPreviewLinks";

export const dynamic = "force-dynamic";

/**
 * `/clients/{id}/portal-preview` — the staff view of a client's portal: its home, and the client's jobs, each opening into the
 * client's own job surfaces (BUILD-staff-portal-preview-job-aware).
 *
 * With the portal shell on (BUILD-portal-shell-lookandfeel), the portal lands on a job's Dashboard, as the client's does: the
 * default job's (newest with a published report). That page is opened — and audited — as that job's dashboard.
 *
 * Authorisation is the API's, not this page's: `support.portal_impersonate` plus the client-scope
 * check, both resolved against the database in `getPortalPreview`. A staff member without the
 * capability gets a 403 here even if they type the URL, and the entry point they never saw is a
 * convenience rather than the control.
 */
export default async function PortalPreviewPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const shell = portalFeatureEnabled("portal-shell") && portalFeatureEnabled("portal-analytics");
  return <PreviewFrame clientId={clientId} surface="home">
    {(preview: PortalPreviewReadModel) => {
      const landing = shell ? defaultShellJob(preview.jobs) : null;
      if (landing) redirect(`${portalPreviewBase(clientId)}/jobs/${encodeURIComponent(landing.id)}/dashboard`);
      return <PortalPreview preview={preview} />;
    }}
  </PreviewFrame>;
}
