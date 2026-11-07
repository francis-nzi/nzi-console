import type { CommandInputMap } from "@nzi/contracts";
import { postReportMessageAsClient } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../../../lib/portalCommand";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client-review loop S5: the client writes to the team on the round (portal.report.message.post). The text is the message only; the email the team gets is a link, never the words. 404 while the flag is off.
 */
export async function POST(request: Request) {
  try {
    if (!portalFeatureEnabled("portal-report-review")) return Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json() as CommandInputMap["portal.report.message.post"];
    return commandSuccess(await postReportMessageAsClient(isolatedPool(), body, portalCommandContext(request, user)));
  } catch (error) { return portalCommandFailure(error); }
}
