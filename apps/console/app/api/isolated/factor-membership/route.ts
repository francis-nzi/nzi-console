import { addMembershipCommand, membershipReport, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { authFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentStaff } from "../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** File a DESNZ factor family under a category (NZC-171) - Admin alone (`factor.manage`). */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "factor.membership.add");
    const body = await request.json() as CommandInputMap["factor.membership.add"];
    return commandSuccess(await addMembershipCommand(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

/** The membership map and what it leaves out (NZC-171): the rules, the unfiled factors, the held-back family. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    return Response.json(await withTenantRead(isolatedPool(), principal.organisationId, (db) => membershipReport(db, principal.organisationId)));
  } catch (error) { return authFailure(error); }
}
