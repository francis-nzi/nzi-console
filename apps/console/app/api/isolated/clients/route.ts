import { listClients, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const clients = await withTenantRead(pool, organisationId, listClients);
    return Response.json({ clients });
  } catch (error) {
    return apiFailure(error);
  }
}
