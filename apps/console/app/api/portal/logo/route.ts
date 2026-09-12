import { getClientLogo, logoResponse, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

// The signed-in portal user's own client logo — never another client's.
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    return logoResponse(await withTenantRead(isolatedPool(), user.organisationId, (db) => getClientLogo(db, user.clientId)), request.headers.get("if-none-match"));
  } catch (error) { return portalAuthFailure(error); }
}
