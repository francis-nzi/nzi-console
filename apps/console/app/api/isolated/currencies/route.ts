import { createCurrency } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a currency (admin E1) — admin.lookups; its ISO code is set here and never again, and never "UAE". */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "currency.create");
    const body = await request.json() as CommandInputMap["currency.create"];
    return commandSuccess(await createCurrency(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
