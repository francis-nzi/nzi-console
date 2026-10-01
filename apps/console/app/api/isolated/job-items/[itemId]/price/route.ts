import { setJobItemPrice } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Set a catalogue item's cost and sell (admin E2) — finance.manage; its audit says which amounts were set, never what (E-Q8). */
export async function PUT(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_item.price.set");
    const { itemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_item.price.set"], "itemId">;
    return commandSuccess(await setJobItemPrice(isolatedPool(), { ...body, itemId: decodeURIComponent(itemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
