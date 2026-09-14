import { assignClientStrategy, removeClientStrategy, updateClientStrategy } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Add an action to this client's plan — a catalogue lever or a bespoke one (actions.manage).
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.strategy.assign");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.strategy.assign"], "clientId">;
    return commandSuccess(await assignClientStrategy(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Status, owner, target date and progress. The client is not in the body: the action's own
// row says whose plan it belongs to, and the access check resolves the client from it.
export async function PATCH(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.strategy.update");
    const body = await request.json() as CommandInputMap["client.strategy.update"];
    return commandSuccess(await updateClientStrategy(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Removing deactivates, never deletes, and carries a reason.
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.strategy.remove");
    const body = await request.json() as CommandInputMap["client.strategy.remove"];
    return commandSuccess(await removeClientStrategy(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
