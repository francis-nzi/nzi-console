import { createVatRate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a VAT rate (admin E1) — admin.lookups; the organisation's first becomes its default. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "vat.create");
    const body = await request.json() as CommandInputMap["vat.create"];
    return commandSuccess(await createVatRate(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
