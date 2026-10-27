import { updateEntryBasisDefault } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Set the basis a category's add-entry drawer opens on (Data entry D1, R4/R6) — admin.settings, versioned per category, audited. */
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "admin.entryBasis.update");
    const body = await request.json() as CommandInputMap["admin.entryBasis.update"];
    return commandSuccess(await updateEntryBasisDefault(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
