import { getTraineePortal, withTenantRead } from "@nzi/isolated-backend";
import { todayInLondon } from "@nzi/contracts";
import { traineeAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentTrainee } from "../../../lib/traineeSession";

export const dynamic = "force-dynamic";

/**
 * One person's whole training record — GET only.
 *
 * The person is the session's own trainee (`trainee.traineeId`), never a parameter: there
 * is no id in this URL to change, so no trainee can read another's history even by
 * guessing. `asAt` is resolved server-side so "upcoming" means one thing for everyone.
 */
export async function GET(request: Request) {
  try {
    const trainee = await currentTrainee(request);
    const model = await withTenantRead(isolatedPool(), trainee.organisationId, (db) =>
      getTraineePortal(db, { traineeId: trainee.traineeId, asAt: todayInLondon() }),
    );
    return Response.json(model, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return traineeAuthFailure(error); }
}
