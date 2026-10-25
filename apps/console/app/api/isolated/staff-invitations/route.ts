import { inviteStaffMember, StaffEnrolmentError } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentStaff, requireAuthOrigin } from "../../../lib/staffSession";
import { authFailure } from "../../../lib/authResponse";

/**
 * Staff invitations from Admin → Team & access (matrix v8, `staff.invite`; email programme phase 3). POST { userId,
 * delivery? }: issues through the one enrolment path (0129). `delivery` is "email" (the default — the invitation is queued
 * to the member's work address and the admin never holds the link) or "link" (a fresh link returned once, for when the
 * email could not reach them). The roster itself is Team & access's own read.
 */
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    if (process.env.NZI_WRITE_API_ENABLED !== "true") return Response.json({ code: "WRITE_API_DISABLED", message: "Write API is disabled." }, { status: 503 });
    requireAuthOrigin(request);
    const principal = await currentStaff(request);
    const body = await request.json() as { userId?: unknown; delivery?: unknown };
    if (typeof body.userId !== "string") throw new StaffEnrolmentError("Choose a member of the team to invite.");
    if (body.delivery !== undefined && body.delivery !== "email" && body.delivery !== "link") throw new StaffEnrolmentError("An invitation is emailed, or issued as a link to copy.");
    const invitation = await inviteStaffMember(isolatedPool(), principal, { userId: body.userId, delivery: body.delivery },
      { consoleOrigin: process.env.NZI_ISOLATED_API_URL ?? "" });
    return Response.json({ invitation }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof StaffEnrolmentError) return Response.json({ code: "INVALID_INVITATION", message: error.message }, { status: 422, headers: noStore });
    return authFailure(error);
  }
}
