import { readCategoryLineYears, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Data entry D3 (R5): one category's lines across the reporting grain — baseline + current + up to four prior years — matched by GL
 * code (else description). The QA drawer's read; `?category=3.1` for PG&S, any category code for the rest.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const category = new URL(request.url).searchParams.get("category")?.trim() ?? "";
    if (!/^[0-9][0-9a-z.-]*$/i.test(category)) return Response.json({ code: "INVALID", message: "Name a category, e.g. ?category=3.1." }, { status: 400 });
    const { pool, organisationId } = requireIsolatedApiContext();
    const lines = await withTenantRead(pool, organisationId, (db) => readCategoryLineYears(db, jobId, category));
    if (!lines) return Response.json({ code: "NOT_FOUND", message: "Line history is available only for CRP jobs." }, { status: 404 });
    return Response.json(lines, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
