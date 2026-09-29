import { createReferenceValue } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a lookup value (admin A2) — admin.lookups, through the command runner. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "reference.value.create");
    const body = await request.json() as CommandInputMap["reference.value.create"];
    return commandSuccess(await createReferenceValue(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
