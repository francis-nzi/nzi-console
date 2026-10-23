import { getPortalJobEmissions } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * The Data view's totals band, narrowed to a site (`?siteId=`) — BUILD-portal-data-crm-parity R2. The CRM's own emissions read,
 * over the rows this client sees (never a hidden category), behind the job's grant. tCO₂e only. Read only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || null;
    return Response.json(await getPortalJobEmissions(isolatedPool(), user, jobId, siteId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
