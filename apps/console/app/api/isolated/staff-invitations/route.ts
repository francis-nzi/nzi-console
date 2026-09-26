import { inviteStaffMember, listStaffEnrolmentRoster, StaffEnrolmentError, staffInviteDeliveryFromEnv } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentStaff, requireAuthOrigin } from "../../../lib/staffSession";
import { authFailure } from "../../../lib/authResponse";

/**
 * Staff invitations from the admin (matrix v8, `staff.invite`). GET: the roster with each member's invitation state.
 * POST { userId }: issues through the one enrolment path (0129) — the link comes back only while mail is suppressed.
 */
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    return Response.json({ members: await listStaffEnrolmentRoster(isolatedPool(), principal) }, { headers: noStore });
  } catch (error) { return authFailure(error); }
}

export async function POST(request: Request) {
  try {
    if (process.env.NZI_WRITE_API_ENABLED !== "true") return Response.json({ code: "WRITE_API_DISABLED", message: "Write API is disabled." }, { status: 503 });
    requireAuthOrigin(request);
    const principal = await currentStaff(request);
    const body = await request.json() as { userId?: unknown };
    if (typeof body.userId !== "string") throw new StaffEnrolmentError("Choose a member of the team to invite.");
    const invitation = await inviteStaffMember(isolatedPool(), principal, { userId: body.userId },
      { consoleOrigin: process.env.NZI_ISOLATED_API_URL ?? "", ...staffInviteDeliveryFromEnv(process.env) });
    return Response.json({ invitation }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof StaffEnrolmentError) return Response.json({ code: "INVALID_INVITATION", message: error.message }, { status: 422, headers: noStore });
    return authFailure(error);
  }
}
