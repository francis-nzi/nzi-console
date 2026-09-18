import { listInputSpec, withTenantRead } from "@nzi/isolated-backend";
import { currentPortalUserForData } from "../../../lib/portalSession";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The governed input spec for the client portal (NZC-102). Authenticated as a portal user and read
// under that user's organisation — the spec is global, but it is never served outside a verified
// session, and the per-client visibility toggle resolves here when it arrives.
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const spec = await withTenantRead(isolatedPool(), user.organisationId, (db) => listInputSpec(db));
    return Response.json({ spec }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
