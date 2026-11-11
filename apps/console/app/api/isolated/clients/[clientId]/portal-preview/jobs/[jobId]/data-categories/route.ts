import { getPortalDataCategoriesForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { requirePortalData } from "../../../../../../../../lib/portalCommand";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The Data view's category list in preview (`/api/portal/jobs/{jobId}/data-categories`): the client's own assembly, GET only. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    requirePortalData();
    const { clientId, jobId } = await params;
    const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || null;
    return previewJson(await getPortalDataCategoriesForStaff(isolatedPool(), principal, clientId, jobId, siteId));
  });
}
