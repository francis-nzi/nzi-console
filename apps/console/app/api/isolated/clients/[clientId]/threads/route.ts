import { listClientThreads, startClientThread } from "@nzi/isolated-backend";
import { readMessageRequest, recordWithAttachments } from "../../../../../lib/messageForm";
import { uploadFailure } from "../../../../../lib/fileUpload";
import { authFailure } from "../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../../../lib/conversations";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The client workspace's Conversations: every thread of this client, the subject tags and the staff a thread can be assigned to - portal.admin on the client. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    requireConversations();
    const principal = await currentStaff(request);
    const { clientId } = await params;
    return Response.json(await listClientThreads(isolatedPool(), principal, clientId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationsOff(error) ?? authFailure(error); }
}

/** Start a conversation with the client (client.thread.start). Body: { jobId, subjectCode, title, body } as JSON, or the same as a multipart form with `file` parts (attachments, M3). */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    requireConversations();
    const principal = await requireCommandPrincipal(request, "client.thread.start");
    const { clientId } = await params;
    const message = await readMessageRequest(request, { organisationId: principal.organisationId, clientId, jobIdFor: (fields) => (fields.jobId as string | null | undefined) ?? null });
    const { fields } = message;
    return commandSuccess(await recordWithAttachments(message, () => startClientThread(isolatedPool(), {
      clientId, jobId: (fields.jobId as string | null | undefined) ?? null, subjectCode: String(fields.subjectCode ?? ""), title: String(fields.title ?? ""), body: String(fields.body ?? ""),
      ...(message.ingests.length ? { attachments: message.ingests } : {}),
    }, commandContext(request, principal))));
  } catch (error) { return conversationsOff(error) ?? uploadFailure(error) ?? commandFailure(error); }
}
