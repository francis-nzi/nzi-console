import { importPortalScopeRows } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal bulk import (BRIEF-portal-data-entry-parity #3): a previewed, confirmed template filed as pending rows, all or none (portal.scope.row.import). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal.scope.row.import"], "jobId">;
    return commandSuccess(await importPortalScopeRows(isolatedPool(), { ...body, jobId }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
