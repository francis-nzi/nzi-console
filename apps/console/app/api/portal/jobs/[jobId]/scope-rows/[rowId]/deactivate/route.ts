import { deactivatePortalScopeRow } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal data-entry phase 2: off unless the client's profile offers it, and with a reason, as staff give one. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId, rowId } = await params;
    const body = await request.json() as { expectedVersion: number };
    return commandSuccess(await deactivatePortalScopeRow(isolatedPool(), { jobId, rowId, expectedVersion: body.expectedVersion }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
