import { markPortalThreadRead } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../../../lib/conversations";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** The client user has read the conversation up to its latest message (portal.thread.read). */
export async function POST(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { threadId } = await params;
    return commandSuccess(await markPortalThreadRead(isolatedPool(), { clientId: user.clientId, threadId }, portalCommandContext(request, user)));
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}
