import type { CommandInputMap } from "@nzi/contracts";
import { approveReportAsClient } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../../../lib/portalCommand";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client-review loop S5: the client's Approve (report.clientApprove), pinned to the version they were looking at. It moves the round to client_approved, locks it for edits and tells the team (an entry in the round's thread and the notify-only email). 404 while the flag is off.
 */
export async function POST(request: Request) {
  try {
    if (!portalFeatureEnabled("portal-report-review")) return Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json() as CommandInputMap["report.clientApprove"];
    return commandSuccess(await approveReportAsClient(isolatedPool(), body, portalCommandContext(request, user)));
  } catch (error) { return portalCommandFailure(error); }
}
