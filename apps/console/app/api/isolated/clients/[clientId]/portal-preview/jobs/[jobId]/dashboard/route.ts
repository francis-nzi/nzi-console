import { getPortalAssuredDashboardForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";
import { isPortalAssuredDashboard } from "../../../../../../../../portal/jobs/[jobId]/portalAnalyticsValidation";

export const dynamic = "force-dynamic";

/** The assured dashboard in preview (`/api/portal/jobs/{jobId}/dashboard`): the job's published snapshot only, never draft rows. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    const dashboard = await getPortalAssuredDashboardForStaff(isolatedPool(), principal, clientId, jobId);
    if (!isPortalAssuredDashboard(dashboard)) return previewJson({ code: "INVALID_ANALYTICS_EVIDENCE", message: "The assured analytics evidence could not be verified." }, 502);
    return previewJson(dashboard);
  });
}
