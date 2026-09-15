import { getPortalClientReadiness, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client portal · UK SRS readiness — GET only. There is no POST/PATCH/DELETE here by design:
 * the assessment is consultant-led in the staff console, and a portal write would fork one
 * assessment into two.
 *
 * Tenancy: the client is the session's own client — `user.clientId`, never a path or query
 * parameter — inside `withTenantRead` on the session's organisation.
 *
 * Resolved live on every request, from the current completed assessment. Deliberately not
 * from `report_compositions`: a frozen readiness belongs in the report the client was sent,
 * not on the page telling them where they stand today.
 */
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const readiness = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getPortalClientReadiness(db, { clientId: user.clientId }),
    );
    return Response.json(readiness, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return portalAuthFailure(error); }
}
