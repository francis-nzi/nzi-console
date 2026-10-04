import { readTimeActivities, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The activities time is logged as, each with its billable default (TIME Addendum). */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const activities = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readTimeActivities(db, principal));
    return Response.json({ activities }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
