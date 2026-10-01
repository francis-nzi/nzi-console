import { deactivateVatRate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a VAT rate (admin E1) — never the default, never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ vatRateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "vat.deactivate");
    const { vatRateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["vat.deactivate"], "vatRateId">;
    return commandSuccess(await deactivateVatRate(isolatedPool(), { ...body, vatRateId: decodeURIComponent(vatRateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
