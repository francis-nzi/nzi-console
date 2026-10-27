import { reinstateSpendAllocation } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R1): route by an archived map entry again — admin.lookups, audited. */
export async function POST(request: Request, { params }: { params: Promise<{ allocationId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.reinstate");
    const { allocationId } = await params;
    const body = await request.json() as { expectedVersion: number };
    return commandSuccess(await reinstateSpendAllocation(isolatedPool(), { expectedVersion: body.expectedVersion, allocationId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
