import { getPortalDataViewForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { requirePortalData } from "../../../../../../../../lib/portalCommand";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The client's Data view in preview (`/api/portal/jobs/{jobId}/data-view`): the same assembly, behind the same `portal-data` flag. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    requirePortalData();
    const { clientId, jobId } = await params;
    return previewJson(await getPortalDataViewForStaff(isolatedPool(), principal, clientId, jobId));
  });
}
