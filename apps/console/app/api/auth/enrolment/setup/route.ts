import { StaffEnrolmentError, startStaffEnrolment } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { requireAuthEnabled, requireAuthOrigin } from "../../../../lib/staffSession";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

/** Staff enrolment, step 1 (0129): the person's own password; returns their authenticator secret to them alone. */
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireAuthEnabled(); requireAuthOrigin(request);
    const body = await request.json() as { token?: unknown; password?: unknown };
    if (typeof body.token !== "string" || typeof body.password !== "string") throw new StaffEnrolmentError();
    const setup = await startStaffEnrolment(isolatedPool(), { token: body.token, password: body.password }, process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY ?? "");
    return Response.json({ setup }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StaffEnrolmentError) return Response.json({ code: "INVALID_ENROLMENT", message: error.message }, { status: 422, headers: { "Cache-Control": "no-store" } });
    return authFailure(error);
  }
}
