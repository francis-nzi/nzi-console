import { updateClient } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { afterSaveLocate } from "../../../../../lib/geolocate";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.update");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.update"], "clientId">;
    const context = commandContext(request, principal);
    const outcome = await updateClient(isolatedPool(), { ...body, clientId }, context);
    // CLIENT-04: a client not yet located (a new or changed registered postcode or country) is located now, best effort.
    return commandSuccess({ ...outcome, data: { ...outcome.data, location: await afterSaveLocate("client", isolatedPool(), clientId, context) } });
  } catch (error) { return commandFailure(error); }
}
