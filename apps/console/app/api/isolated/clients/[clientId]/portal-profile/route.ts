import { getPortalProfileForStaff, setClientPortalProfile } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * Portal data-entry phase 1 — one client's portal profile as staff see it (default, decisions, effective; scopes and their
 * categories), under portal.admin on this client: 403 without it or for an own-clients holder on another's client.
 */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { clientId } = await params;
    return Response.json(await getPortalProfileForStaff(isolatedPool(), principal, clientId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** Decide one of the portal's toggles for this client (client.portal.profile.set); `value: null` returns it to the default. */
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.portal.profile.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.portal.profile.set"], "clientId">;
    return commandSuccess(await setClientPortalProfile(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
