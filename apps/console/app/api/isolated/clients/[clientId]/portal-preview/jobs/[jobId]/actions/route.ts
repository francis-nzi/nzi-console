import { getPortalActionTrackerForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The job's action tracker in preview (`/api/portal/jobs/{jobId}/actions`, GET only): the client's own assembly, read only. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    return previewJson(await getPortalActionTrackerForStaff(isolatedPool(), principal, clientId, jobId));
  });
}
