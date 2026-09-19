import type { ExtractionOutcome } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { lookupVehicleByRegistration, resolveVehicleFactor, type VehicleLookupConfig } from "./vehicleLookup";

/**
 * A registration, proposed as an entry (NZC-113).
 *
 * The second way into the same loop: instead of describing a vehicle, a person gives its number
 * plate. Everything after the lookup is identical — a proposal, a person confirming it, the one
 * governed commit — so this adds a route and not a mechanism.
 *
 * ## Two existing pieces, composed and neither changed
 *
 * `lookupVehicleByRegistration` turns a plate into a vehicle and is already written so the plate
 * does not survive the call: it is used to build the request and never persisted, logged or echoed
 * back (NZC-103's transience, pinned by `registrationTransience.test.ts`). `resolveVehicleFactor`
 * turns that vehicle into a factor from the datasets *this job* selected. Composing them rather
 * than reimplementing either is what keeps the assisted path's guarantees the same as the manual
 * path's, rather than similar to them.
 *
 * ## The plate does not enter the proposal
 *
 * A registration a person types into an entry is stored on the row as its asset identifier, by
 * design and documented for exactly that (NZC-103). What must not happen is the plate travelling
 * inside the *assist record* — the structured proposal and diff that land in the audit event's
 * `after_json` — because that record is permanent and is not the place a registration belongs
 * (NZC-111). So the proposal carries no plate field at all: not omitted carefully, absent. The
 * asset identifier reaches the row the way it always has, from the field the person typed it into,
 * and the audit record has no shape that could hold it.
 *
 * ## A failed lookup says so without repeating the plate
 *
 * The abstention carries the lookup's own message, which is written not to echo the registration.
 * A "we couldn't find AB12 CDE" would put the plate into an error string, and error strings are
 * exactly what gets logged.
 */

export type RegistrationProposalInput = {
  registration: string;
  jobId: string;
  config: VehicleLookupConfig;
};

/** The category a vehicle resolved from a registration belongs to. */
export const VEHICLE_CATEGORY_CODE = "1.company-vehicles";

export async function proposeFromRegistration(
  db: Queryable,
  input: RegistrationProposalInput,
): Promise<ExtractionOutcome> {
  const looked = await lookupVehicleByRegistration(input.registration, input.config);
  if (!looked.ok) {
    // The lookup's own wording, which does not contain the registration.
    return { kind: "abstained", reason: looked.message };
  }

  const factor = await resolveVehicleFactor(db, input.jobId, looked.vehicle);
  if (!factor) {
    return {
      kind: "abstained",
      reason: "That vehicle resolved, but this job's datasets have no matching mobile-combustion factor.",
    };
  }

  return {
    kind: "proposal",
    proposal: {
      categoryCode: VEHICLE_CATEGORY_CODE,
      scope: factor.scope,
      sourceLabel: factor.label,
      // The distance or fuel used is not something a registration can answer. Left null, so the
      // spec finds it missing and the loop asks — rather than a plausible number being invented
      // because one was expected.
      quantity: null,
      unit: factor.unit,
      datasetId: factor.datasetId,
      factorId: factor.factorId,
      values: {
        activity: factor.label,
        quantity: null,
        unit: factor.unit,
        factor: factor.factorId,
      },
    },
  };
}
