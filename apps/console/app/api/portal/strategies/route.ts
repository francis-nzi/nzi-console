import { getPortalClientStrategies, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client portal · reduction plan deadlines — GET only. There is no POST/PATCH/DELETE here
 * by design: the plan is agreed with the NZI consultant and tracked on the client record,
 * so a portal write would fork one plan into two.
 *
 * Tenancy: the client is the session's own client — `user.clientId`, never a path or query
 * parameter — inside `withTenantRead` on the session's organisation.
 *
 * `today` is resolved here, on the server, as a London calendar date. Taking it from the
 * request would let a client's device clock decide whether their own plan is overdue.
 */
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const strategies = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getPortalClientStrategies(db, { clientId: user.clientId, today: londonToday() }),
    );
    return Response.json(strategies, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
