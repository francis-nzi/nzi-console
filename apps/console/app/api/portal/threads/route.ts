import { listPortalThreads, startPortalThread } from "@nzi/isolated-backend";
import { readMessageRequest, recordWithAttachments } from "../../../lib/messageForm";
import { uploadFailure } from "../../../lib/fileUpload";
import { commandSuccess } from "../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../lib/conversations";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** The signed-in client user's conversations: their client's client-wide threads and those of jobs they hold (optionally one job's), with the subject tags to start one under. */
export async function GET(request: Request) {
  try {
    requireConversations();
    const user = await currentPortalUserForData(request);
    const jobId = new URL(request.url).searchParams.get("jobId")?.trim() || null;
    return Response.json(await listPortalThreads(isolatedPool(), user, { jobId }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}

/** Start a conversation (portal.thread.start): on a job the user holds, or client-wide (jobId null). Body: { jobId, subjectCode, title, body } as JSON, or the same as a multipart form with `file` parts (attachments, M3). */
export async function POST(request: Request) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    // JSON as ever, or a multipart form when the message carries files (M3) - each file through the gate before the command records it.
    const message = await readMessageRequest(request, { organisationId: user.organisationId, clientId: user.clientId, jobIdFor: (fields) => (fields.jobId as string | null | undefined) ?? null });
    const { fields } = message;
    return commandSuccess(await recordWithAttachments(message, () => startPortalThread(isolatedPool(), {
      clientId: user.clientId, jobId: (fields.jobId as string | null | undefined) ?? null, subjectCode: String(fields.subjectCode ?? ""), title: String(fields.title ?? ""), body: String(fields.body ?? ""),
      ...(message.ingests.length ? { attachments: message.ingests } : {}),
    }, portalCommandContext(request, user))));
  } catch (error) { return conversationsOff(error) ?? uploadFailure(error) ?? portalCommandFailure(error); }
}
