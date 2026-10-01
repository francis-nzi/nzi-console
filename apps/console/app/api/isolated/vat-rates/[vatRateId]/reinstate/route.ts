import { reinstateVatRate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a VAT rate (admin E1) — admin.lookups. */
export async function POST(request: Request, { params }: { params: Promise<{ vatRateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "vat.reinstate");
    const { vatRateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["vat.reinstate"], "vatRateId">;
    return commandSuccess(await reinstateVatRate(isolatedPool(), { ...body, vatRateId: decodeURIComponent(vatRateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
