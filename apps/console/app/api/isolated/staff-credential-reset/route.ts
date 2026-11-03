import { resetStaffSignIn, StaffEnrolmentError } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentStaff, requireAuthOrigin } from "../../../lib/staffSession";
import { authFailure } from "../../../lib/authResponse";

/**
 * Reset an enrolled member's sign-in from Admin → Team & access (matrix v11, `staff.credential.reset`). POST { userId, reason,
 * delivery? }: their sessions end, their credential is retired, and a fresh single-use enrolment invitation is issued through
 * the one enrolment path — "email" (the default; the admin never holds the link) or "link" (returned once, for when the email
 * could not reach them). Everything happens in one transaction.
 */
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    if (process.env.NZI_WRITE_API_ENABLED !== "true") return Response.json({ code: "WRITE_API_DISABLED", message: "Write API is disabled." }, { status: 503 });
    requireAuthOrigin(request);
    const principal = await currentStaff(request);
    const body = await request.json() as { userId?: unknown; reason?: unknown; delivery?: unknown };
    if (typeof body.userId !== "string") throw new StaffEnrolmentError("Choose a member of the team to reset.");
    if (typeof body.reason !== "string") throw new StaffEnrolmentError("Say why their sign-in is being reset — it is recorded.");
    if (body.delivery !== undefined && body.delivery !== "email" && body.delivery !== "link") throw new StaffEnrolmentError("The new invitation is emailed, or issued as a link to copy.");
    const reset = await resetStaffSignIn(isolatedPool(), principal, { userId: body.userId, reason: body.reason, delivery: body.delivery },
      { consoleOrigin: process.env.NZI_ISOLATED_API_URL ?? "" });
    return Response.json({ reset }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof StaffEnrolmentError) return Response.json({ code: "INVALID_RESET", message: error.message }, { status: 422, headers: noStore });
    return authFailure(error);
  }
}
