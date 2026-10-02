import { updatePortalBroadcast } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a portal broadcast (admin F4) — admin.settings, against its version. */
export async function PATCH(request: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "portal_broadcast.update");
    const { broadcastId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal_broadcast.update"], "broadcastId">;
    return commandSuccess(await updatePortalBroadcast(isolatedPool(), { ...body, broadcastId: decodeURIComponent(broadcastId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
