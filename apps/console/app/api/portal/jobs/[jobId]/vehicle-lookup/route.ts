import { lookupVehicleByRegistration, resolveVehicleFactor, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUser } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

// UX1 — client-portal DVLA registration lookup (constrained mirror of the CRM
// route). Real service; stubbed on isolated staging. The portal never sees the
// factor value — only the vehicle spec and a suggested class — so the consultant
// still maps and calculates. The registration is transient, never persisted.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await currentPortalUser(request);
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

    const factor = await withTenantRead(isolatedPool(), user.organisationId, (db) => resolveVehicleFactor(db, jobId, result.vehicle));
    return Response.json(
      { source: result.source, vehicle: result.vehicle, suggestedClass: result.suggestedClass, matched: factor !== null },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return portalAuthFailure(error);
  }
}
