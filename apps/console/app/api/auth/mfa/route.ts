import { completeStaffMfa } from "@nzi/isolated-backend";
import { authFailure } from "../../../lib/authResponse";
import { requireAuthEnabled, requireAuthOrigin, sessionCookie, signStaffSession } from "../../../lib/staffSession";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireAuthEnabled(); requireAuthOrigin(request);
    const body = await request.json() as { challengeToken?: unknown; code?: unknown };
    if (typeof body.challengeToken !== "string" || typeof body.code !== "string") return Response.json({ code: "INVALID_LOGIN", message: "Invalid email, password, or MFA code." }, { status: 401 });
    // Set only when a recovery code stood in for the authenticator (4-2), so the form can say how many are left.
    let recoveryCodesRemaining: number | undefined;
    const session = await completeStaffMfa(isolatedPool(), { organisationId: process.env.NZI_DEMO_ORGANISATION_ID ?? "", challengeToken: body.challengeToken, code: body.code }, process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY ?? "", new Date(), { onRecoveryCode: (remaining) => { recoveryCodesRemaining = remaining; } });
    return Response.json({ authenticated: true, ...(recoveryCodesRemaining === undefined ? {} : { recoveryCodesRemaining }) }, { headers: { "Set-Cookie": sessionCookie(signStaffSession(session), session.expiresAt - session.issuedAt), "Cache-Control": "no-store" } });
  } catch (error) { return authFailure(error); }
}
