import { markPortalNoticesSeen } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../../lib/conversations";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** The user has seen the updates through a moment (portal.notices.seen): the newest notice they were shown. Body: { seenThrough }. */
export async function POST(request: Request) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json().catch(() => ({})) as { seenThrough?: unknown };
    return commandSuccess(await markPortalNoticesSeen(isolatedPool(), { clientId: user.clientId, seenThrough: String(body.seenThrough ?? "") }, portalCommandContext(request, user)));
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}
