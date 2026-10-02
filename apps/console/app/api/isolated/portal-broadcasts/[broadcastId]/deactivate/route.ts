import { deactivatePortalBroadcast } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Take a portal broadcast down (admin F4) — never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "portal_broadcast.deactivate");
    const { broadcastId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal_broadcast.deactivate"], "broadcastId">;
    return commandSuccess(await deactivatePortalBroadcast(isolatedPool(), { ...body, broadcastId: decodeURIComponent(broadcastId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
