import { updatePortalScopeRow } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal data-entry phase 2: the client changes their own entry while it waits on review (portal.scope.row.update). */
export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId, rowId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal.scope.row.update"], "jobId" | "rowId">;
    return commandSuccess(await updatePortalScopeRow(isolatedPool(), { ...body, jobId, rowId }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
