import { setSupplierItemRate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Set a rate-card service's agreed rate (admin E4) — finance.manage; its audit says it was set or cleared, never the figure (E-Q8). */
export async function PUT(request: Request, { params }: { params: Promise<{ serviceItemId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier_item.rate.set");
    const { serviceItemId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier_item.rate.set"], "serviceItemId">;
    return commandSuccess(await setSupplierItemRate(isolatedPool(), { ...body, serviceItemId: decodeURIComponent(serviceItemId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
