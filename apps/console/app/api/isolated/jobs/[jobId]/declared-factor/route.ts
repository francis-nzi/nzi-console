import { previewDeclaredFactor, withTenantRead } from "@nzi/isolated-backend";
import { SUPPLY_SOURCES, type SupplySource } from "@nzi/contracts";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Stop 2b — the category's declared factor for an entry, for the capture form to show before a quantity is typed.
// Read-only, and a preview only: the write resolves again from the row's own category and refuses anything that
// disagrees (F1), so nothing sent here can decide what is stored. It shares one resolution with the write, so
// what the form shows is what the write commits.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const body = (await request.json().catch(() => ({}))) as { categoryCode?: unknown; scope?: unknown; unit?: unknown; supplySource?: unknown };
    if (typeof body.categoryCode !== "string" || body.categoryCode.trim() === "" || typeof body.scope !== "string" || body.scope.trim() === "") {
      return Response.json({ code: "CATEGORY_REQUIRED", message: "A category and scope are required." }, { status: 400 });
    }
    const supplySource = SUPPLY_SOURCES.includes(body.supplySource as SupplySource) ? body.supplySource as SupplySource : null;
    const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : null;

    const { pool, organisationId } = requireIsolatedApiContext();
    const preview = await withTenantRead(pool, organisationId, (db) => previewDeclaredFactor(db, organisationId, jobId,
      { scope: body.scope as string, unit, supplySource, assertedVehicleAttributes: null }, (body.categoryCode as string).trim()));
    return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
