import { getPortalDataView } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal data-entry phase 2: everything the client's Data view reads, narrowed by their profile (getPortalDataView). */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    return Response.json(await getPortalDataView(isolatedPool(), user, jobId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
