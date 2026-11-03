import { getPortalThread, postPortalMessage } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../../lib/conversations";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** One conversation and its messages, for a client user entitled to it (the list's rule); anything else is refused. */
export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  try {
    requireConversations();
    const user = await currentPortalUserForData(request);
    const { threadId } = await params;
    return Response.json(await getPortalThread(isolatedPool(), user, threadId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}

/** Write in a conversation (portal.message.post). Body: { body }. */
export async function POST(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { threadId } = await params;
    const body = await request.json().catch(() => ({})) as { body?: unknown };
    return commandSuccess(await postPortalMessage(isolatedPool(), { clientId: user.clientId, threadId, body: String(body.body ?? "") }, portalCommandContext(request, user)));
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}
