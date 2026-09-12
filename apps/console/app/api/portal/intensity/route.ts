import { getPortalClientIntensity, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../lib/portalSession";
import { isPortalIntensity } from "../../../portal/intensity/portalIntensityValidation";

export const dynamic = "force-dynamic";

/**
 * Client portal · emissions intensity — GET only. There is no POST/PATCH/DELETE here by
 * design: the portal reads intensity, it never records it (metrics are defined with the
 * NZI consultant on the client, values are captured on the job).
 *
 * Tenancy: the client is the session's own client — `user.clientId`, never a path or query
 * parameter — inside `withTenantRead` on the session's organisation, and the years are
 * limited to jobs this portal user holds a live access grant for.
 */
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const intensity = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getPortalClientIntensity(db, { portalUserId: user.userId, clientId: user.clientId }),
    );
    if (!isPortalIntensity(intensity)) {
      return Response.json(
        { code: "INVALID_INTENSITY_EVIDENCE", message: "The assured intensity evidence could not be verified." },
        { status: 502, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return Response.json(intensity, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
