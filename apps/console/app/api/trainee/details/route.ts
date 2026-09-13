import { updateTraineeDetails } from "@nzi/isolated-backend";
import { traineeAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentTrainee, requireTraineeOrigin } from "../../../lib/traineeSession";

export const dynamic = "force-dynamic";

/**
 * A person maintaining their own record.
 *
 * Deliberately narrow: name, phone, where they work now, and consent. The sign-in email is
 * NOT here — changing it needs the new address verified first, which is `/email-change`.
 * And nothing on this route can reach a training fact: what they attended, who paid and
 * which employer arranged it live on bookings and snapshots, and stay true after they move.
 */
export async function PATCH(request: Request) {
  try {
    const trainee = await currentTrainee(request);
    requireTraineeOrigin(request);
    const body = await request.json() as Record<string, unknown>;
    const text = (value: unknown) => typeof value === "string" ? value : undefined;
    const consent = body.marketingConsent === "granted" || body.marketingConsent === "declined" ? body.marketingConsent : undefined;
    const result = await updateTraineeDetails(isolatedPool(), {
      organisationId: trainee.organisationId,
      traineeId: trainee.traineeId,
      update: {
        fullName: text(body.fullName), phone: text(body.phone),
        currentEmployerName: text(body.currentEmployerName), marketingConsent: consent,
      },
      consentVersion: process.env.NZI_TRAINEE_CONSENT_VERSION ?? "2026-09",
    });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return traineeAuthFailure(error); }
}
