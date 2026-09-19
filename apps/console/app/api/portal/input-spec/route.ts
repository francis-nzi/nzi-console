import { listInputSpecForClient, withTenantRead } from "@nzi/isolated-backend";
import { currentPortalUserForData } from "../../../lib/portalSession";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The governed input spec for the client portal (NZC-102), as this client sees it (NZC-110). The
// spec itself is global; the categories a consultant decided this client does not see are filtered
// out before it leaves, and the response carries no trace of them — a client told how many
// categories were withheld has been told what was withheld.
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const spec = await withTenantRead(isolatedPool(), user.organisationId, (db) => listInputSpecForClient(db, user.clientId));
    return Response.json({ spec }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
