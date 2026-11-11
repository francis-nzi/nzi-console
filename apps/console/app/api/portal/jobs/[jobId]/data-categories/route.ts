import { getPortalDataCategories } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * The Data view's category list, narrowed to the site tab in force (`?siteId=`): the CRM's own per-category figures inside the
 * client's profile gate (getPortalDataCategories), behind the job's grant. The site only narrows; it never shows more. Read only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || null;
    return Response.json(await getPortalDataCategories(isolatedPool(), user, jobId, siteId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
