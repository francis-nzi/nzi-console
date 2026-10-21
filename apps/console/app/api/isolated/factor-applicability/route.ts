import { addFactorApplicabilityCommand } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Mark a base factor applicable under a category, with the pair's labels (dedup slice 5 Step B) — Admin alone (`factor.manage`). */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "factor.applicability.add");
    const body = await request.json() as CommandInputMap["factor.applicability.add"];
    return commandSuccess(await addFactorApplicabilityCommand(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
