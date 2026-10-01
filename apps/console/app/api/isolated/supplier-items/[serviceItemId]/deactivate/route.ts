import { deactivateSupplierItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a rate-card service (admin E4) — never deleted; the reason is required. */
export async function POST(request: Request, { params }: { params: Promise<{ serviceItemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier_item.deactivate");
    const { serviceItemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier_item.deactivate"], "serviceItemId">;
    return commandSuccess(await deactivateSupplierItem(isolatedPool(), { ...body, serviceItemId: decodeURIComponent(serviceItemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
