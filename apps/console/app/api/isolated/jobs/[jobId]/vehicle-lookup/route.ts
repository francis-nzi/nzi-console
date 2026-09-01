import { lookupVehicleByRegistration, resolveVehicleFactor, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// UX1 — DVLA registration lookup for Company Vehicles / Business Travel /
// Employee Commuting. Real service; on isolated staging (no DVLA_VES_API_KEY)
// it returns a deterministic stub. The registration is transient — never
// persisted, never logged, and never echoed back in the response.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const body = (await request.json().catch(() => ({}))) as { registration?: unknown };
    if (typeof body.registration !== "string" || body.registration.trim() === "") {
      return Response.json({ code: "REGISTRATION_REQUIRED", message: "A registration number is required." }, { status: 400 });
    }
    const result = await lookupVehicleByRegistration(body.registration, {
      apiKey: process.env.DVLA_VES_API_KEY,
      allowStub: process.env.NEXT_PUBLIC_APP_ENV === "staging",
    });
    if (!result.ok) return Response.json({ code: "VEHICLE_LOOKUP_FAILED", message: result.message }, { status: result.status });

    const { pool, organisationId } = requireIsolatedApiContext();
    const factor = await withTenantRead(pool, organisationId, (db) => resolveVehicleFactor(db, jobId, result.vehicle));
    return Response.json({ source: result.source, vehicle: result.vehicle, suggestedClass: result.suggestedClass, factor }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
