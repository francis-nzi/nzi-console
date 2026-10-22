import { assertPortalJobAccess, previewDeclaredFactor, withTenantRead } from "@nzi/isolated-backend";
import { SUPPLY_SOURCES, type SupplySource } from "@nzi/contracts";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * Portal data-entry phase 2: the category's declared factor, for the client's entry form to start on (Stop 2b), as the CRM's
 * own preview gives it. Read-only and a preview only: the write resolves again and refuses anything that disagrees.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    // A POST, so the portal's same-origin rule holds for it too, read-only though it is.
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const body = (await request.json().catch(() => ({}))) as { categoryCode?: unknown; scope?: unknown; unit?: unknown; supplySource?: unknown };
    if (typeof body.categoryCode !== "string" || !body.categoryCode.trim() || typeof body.scope !== "string" || !body.scope.trim()) {
      return Response.json({ code: "CATEGORY_REQUIRED", message: "A category and scope are required." }, { status: 400 });
    }
    const supplySource = SUPPLY_SOURCES.includes(body.supplySource as SupplySource) ? body.supplySource as SupplySource : null;
    const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : null;
    const preview = await withTenantRead(isolatedPool(), user.organisationId, async (db) => {
      await assertPortalJobAccess(db, user, jobId);
      return previewDeclaredFactor(db, user.organisationId, jobId, { scope: body.scope as string, unit, supplySource, assertedVehicleAttributes: null }, (body.categoryCode as string).trim());
    });
    return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
