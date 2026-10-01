import { updateJobItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a catalogue item's definition (admin E2) — versioned, admin.lookups; never its code, never its amounts. */
export async function PATCH(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_item.update");
    const { itemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_item.update"], "itemId">;
    return commandSuccess(await updateJobItem(isolatedPool(), { ...body, itemId: decodeURIComponent(itemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
