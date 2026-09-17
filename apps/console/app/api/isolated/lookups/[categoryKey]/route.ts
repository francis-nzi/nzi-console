import { readReferenceValues } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * The values a smart-search offers for one category (NZC-089).
 *
 * Active only. An archived value stays readable on the record that chose it and stops being
 * offered to the next person — `includeArchived` belongs to the admin surface, which has to show
 * what it can reinstate, and is deliberately not reachable from here.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ categoryKey: string }> }) {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const { categoryKey } = await params;
    const values = await readReferenceValues(pool, organisationId, categoryKey);
    return Response.json({ categoryKey, values }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiFailure(error); }
}
