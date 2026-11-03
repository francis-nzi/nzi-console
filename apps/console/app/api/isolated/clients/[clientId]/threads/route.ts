import { listClientThreads, startClientThread } from "@nzi/isolated-backend";
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

/** Start a conversation with the client (client.thread.start). Body: { jobId, subjectCode, title, body }. */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    requireConversations();
    const principal = await requireCommandPrincipal(request, "client.thread.start");
    const { clientId } = await params;
    const body = await request.json().catch(() => ({})) as { jobId?: string | null; subjectCode?: unknown; title?: unknown; body?: unknown };
    return commandSuccess(await startClientThread(isolatedPool(), { clientId, jobId: body.jobId ?? null, subjectCode: String(body.subjectCode ?? ""), title: String(body.title ?? ""), body: String(body.body ?? "") }, commandContext(request, principal)));
  } catch (error) { return conversationsOff(error) ?? commandFailure(error); }
}
