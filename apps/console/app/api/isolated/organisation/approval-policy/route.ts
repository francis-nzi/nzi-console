import { readApprovalPolicySafely, requireCapability, setOrganisationApprovalPolicy, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * Whether the organisation requires independent approval of reports (0215) — what the report studio and the job's release
 * controls show beside publishing, so the control is never silently off. Any staff member who can see reports. If the policy
 * cannot be read the answer is "required" (`source: "unreadable"`), never "relaxed".
 */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "report.view");
    const policy = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readApprovalPolicySafely(db, principal.organisationId));
    return Response.json(policy, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** Turn independent approval on or off — admin.settings, a reason in `x-command-reason`; audited with the old and new answer. */
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.approvalPolicy.set");
    const body = await request.json() as CommandInputMap["organisation.approvalPolicy.set"];
    return commandSuccess(await setOrganisationApprovalPolicy(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
