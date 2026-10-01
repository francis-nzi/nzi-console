import { deactivateSupplier } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a supplier (admin E4) — never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.deactivate");
    const { supplierId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.deactivate"], "supplierId">;
    return commandSuccess(await deactivateSupplier(isolatedPool(), { ...body, supplierId: decodeURIComponent(supplierId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
