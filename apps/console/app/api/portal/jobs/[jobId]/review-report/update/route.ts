import type { CommandInputMap } from "@nzi/contracts";
import { updateReportAsClient } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../../../lib/portalCommand";
import { portalFeatureEnabled } from "../../../../../../lib/portalFlags";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client-review loop S4: the client's "Update" (portal.report.update) - a batch of narrative edits to a round open for their review.
 * The command authorises the user by their live grant on the report's job, gates on the round being open, pins the version they saw
 * and holds every body to the tokenised, no-money rule. 404 while the flag is off.
 */
export async function POST(request: Request) {
  try {
    if (!portalFeatureEnabled("portal-report-review")) return Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json() as CommandInputMap["portal.report.update"];
    return commandSuccess(await updateReportAsClient(isolatedPool(), body, portalCommandContext(request, user)));
  } catch (error) { return portalCommandFailure(error); }
}
