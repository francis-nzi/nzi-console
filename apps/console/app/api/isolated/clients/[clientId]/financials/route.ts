import { getClientFinancials, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try { const { clientId } = await params; const { pool, organisationId } = requireIsolatedApiContext(); return Response.json(await withTenantRead(pool, organisationId, (db) => getClientFinancials(db, clientId))); } catch (error) { return apiFailure(error); }
}