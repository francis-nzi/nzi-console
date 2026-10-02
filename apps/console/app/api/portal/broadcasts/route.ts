import { listLivePortalBroadcasts, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * The broadcasts live for the signed-in portal client (admin F4; R5): to everyone and to this client, warnings first, then
 * newest, five at most — content only. F4 owns which are live; how they look is the portal's.
 */
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const broadcasts = await withTenantRead(isolatedPool(), user.organisationId, (db) => listLivePortalBroadcasts(db, user.clientId));
    return Response.json({ broadcasts }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return portalAuthFailure(error); }
}
