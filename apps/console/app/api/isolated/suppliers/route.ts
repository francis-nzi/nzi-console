import { createSupplier } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a supplier (admin E4) — admin.lookups. The company only: its people and its rate card have commands of their own. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.create");
    const body = await request.json() as CommandInputMap["supplier.create"];
    return commandSuccess(await createSupplier(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
