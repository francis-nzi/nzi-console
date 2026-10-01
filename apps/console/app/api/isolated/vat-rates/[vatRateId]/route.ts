import { updateVatRate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a VAT rate's name and percentage (admin E1) — versioned, admin.lookups. */
export async function PATCH(request: Request, { params }: { params: Promise<{ vatRateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "vat.update");
    const { vatRateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["vat.update"], "vatRateId">;
    return commandSuccess(await updateVatRate(isolatedPool(), { ...body, vatRateId: decodeURIComponent(vatRateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
