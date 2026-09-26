import { completeStaffEnrolment, StaffEnrolmentError } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { requireAuthEnabled, requireAuthOrigin } from "../../../../lib/staffSession";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

/** Staff enrolment, step 2 (0129): a code from the new authenticator. Only a correct one writes the credential. */
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireAuthEnabled(); requireAuthOrigin(request);
    const body = await request.json() as { token?: unknown; code?: unknown };
    if (typeof body.token !== "string" || typeof body.code !== "string") throw new StaffEnrolmentError();
    const result = await completeStaffEnrolment(isolatedPool(), { token: body.token, code: body.code }, process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY ?? "");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StaffEnrolmentError) return Response.json({ code: "INVALID_ENROLMENT", message: error.message }, { status: 422, headers: { "Cache-Control": "no-store" } });
    return authFailure(error);
  }
}
