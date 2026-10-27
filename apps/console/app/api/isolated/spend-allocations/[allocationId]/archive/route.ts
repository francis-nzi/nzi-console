import { archiveSpendAllocation } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R1): stop routing by a map entry — archived, never deleted — admin.lookups, audited. */
export async function POST(request: Request, { params }: { params: Promise<{ allocationId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.archive");
    const { allocationId } = await params;
    const body = await request.json() as { expectedVersion: number };
    return commandSuccess(await archiveSpendAllocation(isolatedPool(), { expectedVersion: body.expectedVersion, allocationId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
