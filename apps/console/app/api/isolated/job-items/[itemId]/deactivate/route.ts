import { deactivateJobItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a catalogue item (admin E2) — never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_item.deactivate");
    const { itemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_item.deactivate"], "itemId">;
    return commandSuccess(await deactivateJobItem(isolatedPool(), { ...body, itemId: decodeURIComponent(itemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
