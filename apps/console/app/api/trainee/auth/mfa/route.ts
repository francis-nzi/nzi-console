import { completeTraineeMfa } from "@nzi/isolated-backend";
import { traineeAuthFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { requireTraineeAuthEnabled, requireTraineeOrigin, signTraineeSession, traineeSessionCookie } from "../../../../lib/traineeSession";

export const dynamic = "force-dynamic";

// Step 2 of 2. The cookie is the trainee realm's own, signed with its own secret, so a
// session from one realm can never be presented to another.
export async function POST(request: Request) {
  try {
    requireTraineeAuthEnabled();
    requireTraineeOrigin(request);
    const body = await request.json() as { challengeToken?: unknown; code?: unknown };
    if (typeof body.challengeToken !== "string" || typeof body.code !== "string") {
      return Response.json({ code: "INVALID_LOGIN", message: "Invalid email, password, or MFA code." }, { status: 401 });
    }
    const session = await completeTraineeMfa(isolatedPool(), {
      organisationId: process.env.NZI_DEMO_ORGANISATION_ID ?? "", challengeToken: body.challengeToken, code: body.code,
    }, process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY ?? "");
    return Response.json({ authenticated: true }, {
      headers: { "Set-Cookie": traineeSessionCookie(signTraineeSession(session), session.expiresAt - session.issuedAt), "Cache-Control": "no-store" },
    });
  } catch (error) { return traineeAuthFailure(error); }
}
