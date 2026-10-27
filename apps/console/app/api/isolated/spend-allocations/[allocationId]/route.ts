import { updateSpendAllocation } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R1): change where a mapped line goes, with its version — admin.lookups, audited with what it replaced. */
export async function PATCH(request: Request, { params }: { params: Promise<{ allocationId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.update");
    const { allocationId } = await params;
    const body = await request.json() as Omit<CommandInputMap["spend_allocation.update"], "allocationId">;
    return commandSuccess(await updateSpendAllocation(isolatedPool(), { ...body, allocationId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
