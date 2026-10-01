import { updateCurrency } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a currency's name and symbol (admin E1) — versioned, admin.lookups; never its code. */
export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "currency.update");
    const { code } = await params;
    const body = await request.json() as Omit<CommandInputMap["currency.update"], "code">;
    return commandSuccess(await updateCurrency(isolatedPool(), { ...body, code: decodeURIComponent(code) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
