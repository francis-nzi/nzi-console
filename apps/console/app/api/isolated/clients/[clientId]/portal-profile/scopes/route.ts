import { setClientPortalScopeVisibility } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Portal data-entry phase 1 — whether this client sees a scope (client.portal.scope.visibility.set); `visible: null` withdraws. */
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.portal.scope.visibility.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.portal.scope.visibility.set"], "clientId">;
    return commandSuccess(await setClientPortalScopeVisibility(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
