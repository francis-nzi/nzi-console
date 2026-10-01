import { updateSupplierItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a rate-card service (admin E4) — admin.lookups, against its version. Never its rate. */
export async function PATCH(request: Request, { params }: { params: Promise<{ serviceItemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier_item.update");
    const { serviceItemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier_item.update"], "serviceItemId">;
    return commandSuccess(await updateSupplierItem(isolatedPool(), { ...body, serviceItemId: decodeURIComponent(serviceItemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
