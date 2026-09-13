import { startTraineeLogin } from "@nzi/isolated-backend";
import { traineeAuthFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { requireTraineeAuthEnabled, requireTraineeOrigin } from "../../../../lib/traineeSession";

export const dynamic = "force-dynamic";

// Step 1 of 2. The response never distinguishes "no such person" from "wrong password" —
// a trainee's email is their personal one, and this endpoint must not confirm whether it
// is registered.
export async function POST(request: Request) {
  try {
    requireTraineeAuthEnabled();
    requireTraineeOrigin(request);
    const body = await request.json() as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return Response.json({ code: "INVALID_LOGIN", message: "Invalid email, password, or MFA code." }, { status: 401 });
    }
    const result = await startTraineeLogin(isolatedPool(), {
      organisationId: process.env.NZI_DEMO_ORGANISATION_ID ?? "", email: body.email, password: body.password,
    });
    return Response.json({ mfaRequired: true, challengeToken: result.challengeToken }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return traineeAuthFailure(error); }
}
