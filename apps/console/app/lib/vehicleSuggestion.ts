import { previewDeclaredFactor, resolveVehicleFactor, vehicleAttributes, type Queryable, type VehicleSpec } from "@nzi/isolated-backend";

/** What the vehicle lookup tells the form: the suggested factor, and the attributes to carry to the write. */
export type VehicleSuggestion = {
  factor: { factorId: string; datasetId: string; label: string; unit: string; resolvedBy: "declared" | "label-match" } | null;
  attributes: { source: "dvla" | "stub"; fuel: string | null; vehicleClass: string | null };
};

/**
 * The factor the lookup suggests for a vehicle, by the category's own rule (Stop 2c, NZC-160 H6).
 *
 * Where the category resolves declaratively the suggestion is the declared factor, resolved from what the lookup
 * says the vehicle is — or nothing, and the entry goes to a person. Never the label ILIKE, whose declines leak back
 * to a Scope 1 per-km guess. Where the category is off, today's ILIKE suggestion stands. One function, used by the
 * route and by the tests that drive the capture path through it (NZC-162), so the two cannot differ.
 */
export async function suggestVehicleFactor(
  db: Queryable, organisationId: string, jobId: string, vehicle: VehicleSpec, source: "dvla" | "stub",
  categoryCode: string | null, scope: string | null,
): Promise<VehicleSuggestion> {
  const derived = vehicleAttributes(vehicle);
  const attributes = { source, fuel: derived.fuel ?? null, vehicleClass: derived.class ?? null };
  if (categoryCode && scope) {
    const preview = await previewDeclaredFactor(db, organisationId, jobId,
      { scope, unit: null, supplySource: null, assertedVehicleAttributes: attributes }, categoryCode);
    if (preview.enabled) {
      const declared = preview.declared;
      return { attributes, factor: declared
        ? { factorId: declared.factorId, datasetId: declared.datasetId, label: declared.label, unit: declared.unit, resolvedBy: "declared" }
        : null };
    }
  }
  const matched = await resolveVehicleFactor(db, jobId, vehicle);
  return { attributes, factor: matched
    ? { factorId: matched.factorId, datasetId: matched.datasetId, label: matched.label, unit: matched.unit, resolvedBy: "label-match" }
    : null };
}
