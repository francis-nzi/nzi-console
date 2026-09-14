import { getReportComposition, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * What an issued report froze — read back, never rebuilt.
 *
 * GET only. A composition is evidence of what the client was sent; correcting it means
 * issuing a new report version, so there is nothing here to write through.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const { versionId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ composition: await withTenantRead(pool, organisationId, (db) => getReportComposition(db, versionId)) });
  } catch (error) { return apiFailure(error); }
}
