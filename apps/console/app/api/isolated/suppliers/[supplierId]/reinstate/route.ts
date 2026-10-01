import { reinstateSupplier } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a supplier (admin E4) — admin.lookups. */
export async function POST(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.reinstate");
    const { supplierId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.reinstate"], "supplierId">;
    return commandSuccess(await reinstateSupplier(isolatedPool(), { ...body, supplierId: decodeURIComponent(supplierId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
