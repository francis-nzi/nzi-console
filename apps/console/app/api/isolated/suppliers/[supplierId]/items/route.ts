import { createSupplierItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a service to a supplier's rate card (admin E4) — admin.lookups. No rate: that is supplier_item.rate.set. */
export async function POST(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier_item.create");
    const { supplierId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier_item.create"], "supplierId">;
    return commandSuccess(await createSupplierItem(isolatedPool(), { ...body, supplierId: decodeURIComponent(supplierId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
