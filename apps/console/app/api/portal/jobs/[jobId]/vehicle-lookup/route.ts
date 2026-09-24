import { lookupVehicleByRegistration, withTenantRead } from "@nzi/isolated-backend";
import { suggestVehicleFactor } from "../../../../../lib/vehicleSuggestion";
import { portalAuthFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

// UX1 — client-portal DVLA registration lookup (constrained mirror of the CRM
// route). Real service; stubbed on isolated staging. The portal never sees the
// factor value — only the vehicle spec and a suggested class — so the consultant
// still maps and calculates. The registration is transient, never persisted.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
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

    // Stop 2d (P3): the same suggestion the CRM uses — declared for an enabled category, never the ILIKE there — and the
    // attributes (fuel and class, never the plate) for the draft to carry to acceptance. The factor itself is not sent
    // to the client: the bucket's authorised list decides what they may pick, and acceptance re-resolves regardless.
    const category = typeof body.categoryCode === "string" && body.categoryCode.trim() ? body.categoryCode.trim() : null;
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : null;
    const { factor, attributes } = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      suggestVehicleFactor(db, user.organisationId, jobId, result.vehicle, result.source, category, scope));
    return Response.json(
      { source: result.source, vehicle: result.vehicle, suggestedClass: result.suggestedClass, matched: factor !== null, attributes },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return portalAuthFailure(error);
  }
}
