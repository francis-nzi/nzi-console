import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { afterSaveLocate } from "../../../../../lib/geolocate";

export const dynamic = "force-dynamic";

/** CLIENT-04: the retry — locate the client again from its registered postcode and country (client.edit), best effort. */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.location.set");
    const { clientId } = await params;
    return Response.json({ data: { clientId, location: await afterSaveLocate("client", isolatedPool(), clientId, commandContext(request, principal)) } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return commandFailure(error); }
}
