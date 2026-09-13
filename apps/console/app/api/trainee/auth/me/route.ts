import { traineeAuthFailure } from "../../../../lib/authResponse";
import { currentTrainee } from "../../../../lib/traineeSession";

export const dynamic = "force-dynamic";

// Who is signed in, and nothing more. The person's training is a separate read, so a
// header render never pulls their whole history along with it.
export async function GET(request: Request) {
  try {
    const trainee = await currentTrainee(request);
    return Response.json(
      { traineeId: trainee.traineeId, fullName: trainee.fullName, email: trainee.email, idleLimitMinutes: trainee.idleLimitMinutes },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) { return traineeAuthFailure(error); }
}
