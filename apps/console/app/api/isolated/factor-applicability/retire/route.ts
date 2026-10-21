import { retireFactorApplicabilityCommand } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Retire a factor's category (dedup slice 5 Step B) — never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "factor.applicability.retire");
    const body = await request.json() as CommandInputMap["factor.applicability.retire"];
    return commandSuccess(await retireFactorApplicabilityCommand(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
