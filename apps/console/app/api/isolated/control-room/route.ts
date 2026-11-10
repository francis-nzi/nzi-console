import { todayInLondon } from "@nzi/contracts";
import { AuthorizationError, readCrmControlRoom, withTenantRead } from "@nzi/isolated-backend";
import { AuthDisabledError, AuthenticationError, currentStaff } from "../../../lib/staffSession";
import { apiFailure, isolatedPool } from "../../../lib/isolatedDatabase";
import { authFailure } from "../../../lib/authResponse";

/**
 * The personalised Control Room (BRIEF-crm-control-room-redesign, Phase 1): the signed-in CRM's own counts and recent jobs.
 * The CRM is the session's principal, never a parameter — a request cannot ask for someone else's work. Read-only.
 * A sign-in problem answers as one; anything else is the data service's failure, not a sign-in's.
 */
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const data = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readCrmControlRoom(db, { userId: principal.userId, today: todayInLondon() }));
    return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return error instanceof AuthDisabledError || error instanceof AuthenticationError || error instanceof AuthorizationError ? authFailure(error) : apiFailure(error);
  }
}
