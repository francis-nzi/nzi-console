import { retireMembershipCommand } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Retire a membership rule (NZC-171) — never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "factor.membership.retire");
    const body = await request.json() as CommandInputMap["factor.membership.retire"];
    return commandSuccess(await retireMembershipCommand(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
