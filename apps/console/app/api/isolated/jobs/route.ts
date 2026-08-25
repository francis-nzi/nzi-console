import { listJobs, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const jobs = await withTenantRead(pool, organisationId, listJobs);
    return Response.json({ jobs });
  } catch (error) {
    return apiFailure(error);
  }
}
