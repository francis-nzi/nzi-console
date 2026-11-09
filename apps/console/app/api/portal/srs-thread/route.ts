import { getPortalSrsThread, postPortalSrsMessage } from "@nzi/isolated-backend";
import { commandSuccess } from "../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../lib/conversations";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client portal · SRS messaging (Phase B): the client's one conversation about their readiness. The client is always the session's
 * own (`user.clientId`, never a parameter). The readiness itself stays read-only (`/api/portal/readiness` is GET only): a message is
 * the client's only write here, and a review request in it is surfaced to their adviser, never acted on. Dark with the conversations.
 */
export async function GET(request: Request) {
  try {
    requireConversations();
    const user = await currentPortalUserForData(request);
    return Response.json(await getPortalSrsThread(isolatedPool(), user), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}

/** Write about your readiness (portal.srs.message.post). Body: { body, reviewRequest? }. */
export async function POST(request: Request) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const input = await request.json() as { body?: unknown; reviewRequest?: unknown };
    return commandSuccess(await postPortalSrsMessage(isolatedPool(), {
      clientId: user.clientId, body: String(input.body ?? ""), ...(input.reviewRequest === true ? { reviewRequest: true } : {}),
    }, portalCommandContext(request, user)));
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}
