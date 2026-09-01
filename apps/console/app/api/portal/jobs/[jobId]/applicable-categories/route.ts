import { listJobApplicableCategories, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUser } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

// NZC-046 / UX1a — the portal shows only the categories the client's bucket
// grants authorise (not the full 15).
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await currentPortalUser(request);
    const { jobId } = await params;
    const result = await withTenantRead(isolatedPool(), user.organisationId, (db) => listJobApplicableCategories(db, jobId, "portal"));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
