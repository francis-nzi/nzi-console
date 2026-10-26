import { approveClientProposal, declineClientProposal } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Actions A2, R2: the CRM's ruling on a client's proposed action (strategy.manage). The client is not in the body: the
// proposal's own row says whose plan it is, and the access check resolves the client from it.

// Approve — it joins the plan Agreed, aligned to what it advances, worded as the consultant settles it.
export async function PATCH(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.strategy.proposal.approve");
    const body = await request.json() as CommandInputMap["client.strategy.proposal.approve"];
    return commandSuccess(await approveClientProposal(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Decline — with the reason the client is shown, carried as the command's reason header as well.
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.strategy.proposal.decline");
    const body = await request.json() as CommandInputMap["client.strategy.proposal.decline"];
    return commandSuccess(await declineClientProposal(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
