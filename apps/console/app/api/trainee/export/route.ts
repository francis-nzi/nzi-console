import { getTraineePortal, withTenantRead } from "@nzi/isolated-backend";
import { traineeAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentTrainee } from "../../../lib/traineeSession";

export const dynamic = "force-dynamic";

/**
 * "Export my data" — the data-subject access right, served as a file.
 *
 * It is deliberately the same read model the page renders rather than a second query: an
 * export that could show something the person cannot see on screen would be a different
 * dataset wearing the same name. What they read is what they get.
 */
export async function GET(request: Request) {
  try {
    const trainee = await currentTrainee(request);
    const model = await withTenantRead(isolatedPool(), trainee.organisationId, (db) =>
      getTraineePortal(db, { traineeId: trainee.traineeId, asAt: new Date().toISOString().slice(0, 10) }),
    );
    const body = JSON.stringify({
      exportedAt: new Date().toISOString(),
      about: "Everything held about you in NZI's training records: your details, your bookings and attendance, and your certificates.",
      issuer: "Net Zero International",
      ...model,
    }, null, 2);
    const filename = `nzi-training-record-${model.asAt}.json`;
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) { return traineeAuthFailure(error); }
}
