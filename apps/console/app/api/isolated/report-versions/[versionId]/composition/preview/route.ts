import { previewReportComposition, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * B0 (RULING-report-studio-consolidation) — the composed preview of a validated report version: what publish would freeze,
 * composed now in a READ ONLY transaction and stored nowhere. GET only; null for a version that is not validated (a published
 * version is read from its frozen composition, never re-composed).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const { versionId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ preview: await withTenantRead(pool, organisationId, (db) => previewReportComposition(db, { organisationId, reportVersionId: versionId })) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
