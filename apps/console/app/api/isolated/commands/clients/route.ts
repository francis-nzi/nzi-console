import { createClient } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { afterSaveLocate } from "../../../../lib/geolocate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.create");
    const input = await request.json() as CommandInputMap["client.create"];
    const context = commandContext(request, principal);
    const outcome = await createClient(isolatedPool(), input, context);
    // CLIENT-04: located from the registered postcode and country, best effort; the client is created either way.
    return commandSuccess({ ...outcome, data: { ...outcome.data, location: await afterSaveLocate("client", isolatedPool(), outcome.data.clientId, context) } });
  } catch (error) { return commandFailure(error); }
}
