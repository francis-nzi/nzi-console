import { promoteClientProposal } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Actions A2, R3: copy a client's approved proposal into the shared library (admin.lookups, as the library itself) —
// deliberate, once, audited; never automatic and never the client's.
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "strategy.library.promote");
    const body = await request.json() as CommandInputMap["strategy.library.promote"];
    return commandSuccess(await promoteClientProposal(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
