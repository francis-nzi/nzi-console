import { redirect } from "next/navigation";
import type { PortalPreviewReadModel } from "@nzi/isolated-backend";
import { PreviewFrame } from "../../../PreviewFrame";
import { PortalReductionPlan } from "../../../../../../portal/PortalReductionPlan";
import { PortalActionTrackerPanel } from "../../../../../../portal/jobs/[jobId]/PortalActionTracker";
import { portalPreviewBase } from "../../../../../../portal/portalPreviewLinks";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";

export const dynamic = "force-dynamic";

/**
 * Actions as the client sees them: the plan from the preview's own read (the client's resolver, R1 of #506) and the job's action
 * tracker through the preview's GET-only mirror — read only, with no add or edit.
 */
export default async function PortalPreviewActionsPage({ params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  const { clientId, jobId } = await params;
  if (!portalFeatureEnabled("portal-plan")) redirect(`${portalPreviewBase(clientId)}/jobs/${encodeURIComponent(jobId)}`);
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="actions">
    {(preview: PortalPreviewReadModel) => <>
      <PortalReductionPlan model={preview.strategies} />
      {portalFeatureEnabled("portal-actions") ? <PortalActionTrackerPanel jobId={jobId} /> : null}
    </>}
  </PreviewFrame>;
}
