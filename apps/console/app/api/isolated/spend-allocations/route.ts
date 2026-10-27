import { createSpendAllocation } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R1): map a client's GL code or description to the category its spend lines belong in — admin.lookups, audited. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.create");
    const body = await request.json() as CommandInputMap["spend_allocation.create"];
    return commandSuccess(await createSpendAllocation(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
