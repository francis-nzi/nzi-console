import { getPortalClientTraining, withTenantRead } from "@nzi/isolated-backend";
import { todayInLondon } from "@nzi/contracts";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client portal · training — GET only. The portal never books a place, records attendance
 * or issues a certificate: places are booked with the NZI consultant, and a certificate is
 * the trainee's, not their employer's.
 *
 * Tenancy: the client is the session's own client — `user.clientId`, never a path or query
 * parameter — inside `withTenantRead` on the session's organisation. The read model filters
 * each register row on the employer frozen at booking, so a person's training with a
 * previous employer is not visible here even though it is the same person.
 *
 * `asAt` is resolved on the server so every expiry and validity on the page is judged
 * against one date, not against whatever the viewer's clock says.
 */
export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const training = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getPortalClientTraining(db, { portalUserId: user.userId, clientId: user.clientId, asAt: todayInLondon() }),
    );
    return Response.json(training, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
