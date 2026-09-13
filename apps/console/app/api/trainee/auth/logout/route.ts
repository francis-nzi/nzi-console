import { traineeAuthFailure } from "../../../../lib/authResponse";
import { clearTraineeSessionCookie, endTraineeSession, requireTraineeAuthEnabled, requireTraineeOrigin } from "../../../../lib/traineeSession";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireTraineeAuthEnabled();
    requireTraineeOrigin(request);
    await endTraineeSession(request);
    return Response.json({ authenticated: false }, { headers: { "Set-Cookie": clearTraineeSessionCookie(), "Cache-Control": "no-store" } });
  } catch (error) { return traineeAuthFailure(error); }
}
