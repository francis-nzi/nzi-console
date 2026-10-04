import { editTimeEntry } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit one's own entry until it is billed (time.entry.edit). */
export async function PATCH(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "time.entry.edit");
    const { entryId } = await params;
    const body = await request.json() as Omit<CommandInputMap["time.entry.edit"], "entryId">;
    return commandSuccess(await editTimeEntry(isolatedPool(), { ...body, entryId: decodeURIComponent(entryId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
