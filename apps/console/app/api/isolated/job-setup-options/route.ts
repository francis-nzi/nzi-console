import { listJobSetupOptions, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** What the job-creation form offers (PR 3): active job types, with the template each names, and active templates. */
export async function GET() {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool, organisationId, (db) => listJobSetupOptions(db)));
  } catch (error) { return apiFailure(error); }
}
