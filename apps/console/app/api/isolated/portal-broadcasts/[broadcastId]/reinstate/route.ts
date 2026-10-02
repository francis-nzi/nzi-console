import { reinstatePortalBroadcast } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Put a portal broadcast back up (admin F4) — admin.settings. */
export async function POST(request: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "portal_broadcast.reinstate");
    const { broadcastId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal_broadcast.reinstate"], "broadcastId">;
    return commandSuccess(await reinstatePortalBroadcast(isolatedPool(), { ...body, broadcastId: decodeURIComponent(broadcastId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
