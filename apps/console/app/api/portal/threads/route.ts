import { listPortalThreads, startPortalThread } from "@nzi/isolated-backend";
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

/** Start a conversation (portal.thread.start): on a job the user holds, or client-wide (jobId null). Body: { jobId, subjectCode, title, body }. */
export async function POST(request: Request) {
  try {
    requireConversations();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json().catch(() => ({})) as Partial<Omit<import("@nzi/contracts").CommandInputMap["portal.thread.start"], "clientId">>;
    return commandSuccess(await startPortalThread(isolatedPool(), { clientId: user.clientId, jobId: body.jobId ?? null, subjectCode: String(body.subjectCode ?? ""), title: String(body.title ?? ""), body: String(body.body ?? "") }, portalCommandContext(request, user)));
  } catch (error) { return conversationsOff(error) ?? portalCommandFailure(error); }
}
