import { getPortalThread, postPortalMessage } from "@nzi/isolated-backend";
import { readMessageRequest, recordWithAttachments } from "../../../../lib/messageForm";
import { uploadFailure } from "../../../../lib/fileUpload";
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

/** Write in a conversation (portal.message.post). Body: { body } as JSON, or a multipart form with `body` and `file` parts (attachments, M3). */
export async function POST(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { threadId } = await params;
    // The thread is read first - which refuses one this user may not see - so no file is stored for a conversation they cannot write in.
    const message = await readMessageRequest(request, { organisationId: user.organisationId, clientId: user.clientId, jobIdFor: async () => (await getPortalThread(isolatedPool(), user, threadId)).thread.jobId });
    return commandSuccess(await recordWithAttachments(message, () => postPortalMessage(isolatedPool(), {
      clientId: user.clientId, threadId, body: String(message.fields.body ?? ""), ...(message.ingests.length ? { attachments: message.ingests } : {}),
    }, portalCommandContext(request, user))));
  } catch (error) { return conversationsOff(error) ?? uploadFailure(error) ?? portalCommandFailure(error); }
}
