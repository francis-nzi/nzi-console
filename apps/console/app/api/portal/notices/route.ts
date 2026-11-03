import { getPortalNotices } from "@nzi/isolated-backend";
import { conversationsOff, requireConversations } from "../../../lib/conversations";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { portalCommandFailure } from "../../../lib/portalCommand";
import { currentPortalUserForData } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * The Updates feed for the signed-in client user, and the unread count the bell shows: notices derived at read time from events that already exist
 * (a published report, a reviewer's decision on their own entries, a closing data-entry window, a live broadcast) - their client's, and only jobs they
 * hold. Read-only. Behind `portal-conversations` (404 while off).
 */
export async function GET(request: Request) {
  try {
    requireConversations();
    const user = await currentPortalUserForData(request);
    return Response.json(await getPortalNotices(isolatedPool(), user), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}
