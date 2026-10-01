import { deactivateCurrency } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a currency (admin E1) — never the default, never deleted; clients holding it keep it. The reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "currency.deactivate");
    const { code } = await params;
    const body = await request.json() as Omit<CommandInputMap["currency.deactivate"], "code">;
    return commandSuccess(await deactivateCurrency(isolatedPool(), { ...body, code: decodeURIComponent(code) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
