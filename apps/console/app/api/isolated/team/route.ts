import { readTeamMembers } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * The team roster the owner and client-manager smart-searches resolve against (NZC-089).
 *
 * Active memberships only, each carrying `named` so a caller can tell a real name from a handle
 * standing in for one. No credentials, no capabilities — this answers "who is on the team", and a
 * field that needs to know what they may do asks the permission model instead.
 */
export async function GET() {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const members = await readTeamMembers(pool, organisationId);
    return Response.json({ members }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiFailure(error); }
}
