import { lookupVehicleByRegistration, withTenantRead } from "@nzi/isolated-backend";
import { suggestVehicleFactor } from "../../../../../lib/vehicleSuggestion";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// UX1 — DVLA registration lookup for Company Vehicles / Business Travel /
// Employee Commuting. Real service; on isolated staging (no DVLA_VES_API_KEY)
// it returns a deterministic stub. The registration is transient — never
// persisted, never logged, and never echoed back in the response.
//
// Stop 2c (NZC-160 H6): where the entry's category resolves declaratively, the suggested factor is the declared
// one, resolved from what the lookup says the vehicle is — never the label ILIKE, whose declines leak back to a
// Scope 1 per-km guess. The attributes (fuel and class, never the plate) go back to the form, which carries them
// to the write so it can re-resolve (F3). A category that is not switched on keeps today's suggestion.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const body = (await request.json().catch(() => ({}))) as { registration?: unknown; categoryCode?: unknown; scope?: unknown };
    if (typeof body.registration !== "string" || body.registration.trim() === "") {
      return Response.json({ code: "REGISTRATION_REQUIRED", message: "A registration number is required." }, { status: 400 });
    }
    const result = await lookupVehicleByRegistration(body.registration, {
      apiKey: process.env.DVLA_VES_API_KEY,
      allowStub: process.env.NEXT_PUBLIC_APP_ENV === "staging",
    });
    if (!result.ok) return Response.json({ code: "VEHICLE_LOOKUP_FAILED", message: result.message }, { status: result.status });

    const category = typeof body.categoryCode === "string" && body.categoryCode.trim() ? body.categoryCode.trim() : null;
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : null;
    const { pool, organisationId } = requireIsolatedApiContext();
    const { factor, attributes } = await withTenantRead(pool, organisationId, (db) =>
      suggestVehicleFactor(db, organisationId, jobId, result.vehicle, result.source, category, scope));
    return Response.json({ source: result.source, vehicle: result.vehicle, suggestedClass: result.suggestedClass, factor, attributes },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
