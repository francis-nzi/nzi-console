import { getClientThread, postClientMessage, updateClientThread } from "@nzi/isolated-backend";
import { readMessageRequest, recordWithAttachments } from "../../../../../../lib/messageForm";
import { uploadFailure } from "../../../../../../lib/fileUpload";
import type { PortalThreadState } from "@nzi/contracts";
import { authFailure } from "../../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../../../../lib/conversations";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ clientId: string; threadId: string }> };

/** One conversation with its messages and the names of who wrote them - portal.admin on the client. */
export async function GET(request: Request, { params }: Params) {
  try {
    requireConversations();
    const principal = await currentStaff(request);
    const { clientId, threadId } = await params;
    return Response.json(await getClientThread(isolatedPool(), principal, clientId, threadId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationsOff(error) ?? authFailure(error); }
}

/** Reply to the client (client.message.post). Body: { body } as JSON, or a multipart form with `body` and `file` parts (attachments, M3). */
export async function POST(request: Request, { params }: Params) {
  try {
    requireConversations();
    const principal = await requireCommandPrincipal(request, "client.message.post");
    const { clientId, threadId } = await params;
    const message = await readMessageRequest(request, { organisationId: principal.organisationId, clientId, jobIdFor: async () => (await getClientThread(isolatedPool(), principal, clientId, threadId)).thread.jobId });
    return commandSuccess(await recordWithAttachments(message, () => postClientMessage(isolatedPool(), {
      clientId, threadId, body: String(message.fields.body ?? ""), ...(message.ingests.length ? { attachments: message.ingests } : {}),
    }, commandContext(request, principal))));
  } catch (error) { return conversationsOff(error) ?? uploadFailure(error) ?? commandFailure(error); }
}

/** Assign and/or set the state (client.thread.update). Body: { expectedVersion, ownerId?, state? }. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    requireConversations();
    const principal = await requireCommandPrincipal(request, "client.thread.update");
    const { clientId, threadId } = await params;
    const body = await request.json().catch(() => ({})) as { expectedVersion?: number; ownerId?: string | null; state?: PortalThreadState };
    return commandSuccess(await updateClientThread(isolatedPool(), { clientId, threadId, expectedVersion: Number(body.expectedVersion), ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}), ...(body.state !== undefined ? { state: body.state } : {}) }, commandContext(request, principal)));
  } catch (error) { return conversationsOff(error) ?? commandFailure(error); }
}
