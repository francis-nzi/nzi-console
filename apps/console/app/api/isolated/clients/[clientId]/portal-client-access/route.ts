import { getClientPortalAccess, setClientPortalAccess } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** Portal Management → Access: the record (or the defaults), who can sign in, the decision log and the recent sign-in attempts — portal.admin on this client. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { clientId } = await params;
    return Response.json(await getClientPortalAccess(isolatedPool(), principal, clientId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** One save of the Access tab (client.portal.access.set): the switch, expiry and the informational fields, with one decision per changed field. */
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.portal.access.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.portal.access.set"], "clientId">;
    return commandSuccess(await setClientPortalAccess(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
