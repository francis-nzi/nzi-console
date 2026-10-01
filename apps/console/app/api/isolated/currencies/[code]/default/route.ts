import { setDefaultCurrency } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Make a currency the default (admin E1) — the old one cleared in the same command; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "currency.set_default");
    const { code } = await params;
    const body = await request.json() as Omit<CommandInputMap["currency.set_default"], "code">;
    return commandSuccess(await setDefaultCurrency(isolatedPool(), { ...body, code: decodeURIComponent(code) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
