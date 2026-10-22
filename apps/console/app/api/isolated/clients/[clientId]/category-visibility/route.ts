import { setClientCategoryVisibility } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Whether this client sees a category (client.category.visibility.set, NZC-110) — the existing command, which had no staff
 * route until Portal Management (portal data-entry phase 1). `visible: null` withdraws the decision.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.category.visibility.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.category.visibility.set"], "clientId">;
    return commandSuccess(await setClientCategoryVisibility(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
