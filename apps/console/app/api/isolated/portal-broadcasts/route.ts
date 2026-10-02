import { createPortalBroadcast } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Write a portal broadcast (admin F4) — admin.settings; a style, an allow-listed link (both or neither) and a window. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "portal_broadcast.create");
    const body = await request.json() as CommandInputMap["portal_broadcast.create"];
    return commandSuccess(await createPortalBroadcast(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
