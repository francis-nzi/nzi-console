import { getPortalRowHistory } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal data-entry phase 2: a row's History for the client, always available (section 4), by you or your adviser, never a name. */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    requirePortalData();
    const user = await currentPortalUserForData(request);
    const { jobId, rowId } = await params;
    return Response.json({ history: await getPortalRowHistory(isolatedPool(), user, jobId, rowId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
