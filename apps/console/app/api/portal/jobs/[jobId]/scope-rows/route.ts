import { createPortalScopeRow } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal data-entry phase 2: a client's entry on the job's own scope rows (portal.scope.row.create), pending and never reviewed. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal.scope.row.create"], "jobId">;
    return commandSuccess(await createPortalScopeRow(isolatedPool(), { ...body, jobId }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
