import { setVehicleRegistrationsOptOut } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * D4 (R1, R8): whether this client's vehicle registrations are held — sealed under the client's own key — or not at all
 * (client.vehicle_registrations.set, under client.edit). Opting out shreds the key and clears every plate held.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.vehicle_registrations.set");
    const { clientId } = await params;
    const body = await request.json() as { optOut?: unknown; expectedVersion?: unknown };
    return commandSuccess(await setVehicleRegistrationsOptOut(isolatedPool(),
      { clientId, optOut: body.optOut === true, expectedVersion: Number(body.expectedVersion) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
