import { readOrganisationHistory, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The organisation record's audit history — admin.settings. Field names only, never a value. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "admin.settings");
    const history = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readOrganisationHistory(db, principal.organisationId));
    return Response.json({ history }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
