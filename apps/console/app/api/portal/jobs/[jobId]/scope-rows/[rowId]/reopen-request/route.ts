import { requestScopeRowReopen } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * Data entry D3 (R6): the client asks the CRM to reopen a reviewed entry — a request with a reason, sent to the CRM as a message.
 * No self-serve recall: nothing about the entry changes until the CRM edits it. The job link in the message is the console's own
 * origin, never anything from the request.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId, rowId } = await params;
    const body = await request.json() as { expectedVersion?: unknown; reason?: unknown };
    return commandSuccess(await requestScopeRowReopen(isolatedPool(),
      { jobId, rowId, expectedVersion: Number(body.expectedVersion), reason: typeof body.reason === "string" ? body.reason : "" },
      portalCommandContext(request, user), process.env.NZI_ISOLATED_API_URL || null));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
