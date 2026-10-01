import { setDefaultVatRate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Make a VAT rate the default (admin E1) — the old one cleared in the same command; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ vatRateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "vat.set_default");
    const { vatRateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["vat.set_default"], "vatRateId">;
    return commandSuccess(await setDefaultVatRate(isolatedPool(), { ...body, vatRateId: decodeURIComponent(vatRateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
