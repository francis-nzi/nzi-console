import { reinstateJobItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a catalogue item (admin E2) — admin.lookups. */
export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_item.reinstate");
    const { itemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_item.reinstate"], "itemId">;
    return commandSuccess(await reinstateJobItem(isolatedPool(), { ...body, itemId: decodeURIComponent(itemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
