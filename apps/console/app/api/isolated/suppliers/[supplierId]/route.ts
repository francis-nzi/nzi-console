import { updateSupplier } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a supplier's name and website (admin E4) — admin.lookups, against its version. */
export async function PATCH(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.update");
    const { supplierId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.update"], "supplierId">;
    return commandSuccess(await updateSupplier(isolatedPool(), { ...body, supplierId: decodeURIComponent(supplierId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
