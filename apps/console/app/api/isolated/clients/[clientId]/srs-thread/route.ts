import { postSrsMessage } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../../../lib/conversations";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// SRS messaging (Phase B): the CRM replies in the client's SRS readiness conversation (srs.manage). The client is told by a
// notify-only email, a link — never the words. Dark with the conversations.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    requireConversations();
    const principal = await requireCommandPrincipal(request, "srs.message.post");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.message.post"], "clientId">;
    return commandSuccess(await postSrsMessage(isolatedPool(), { body: String(body.body ?? ""), clientId }, commandContext(request, principal)));
  } catch (error) { return conversationsOff(error) ?? commandFailure(error); }
}
