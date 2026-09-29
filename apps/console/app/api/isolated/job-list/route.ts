import { jobListSpec, parseListQuery, todayInLondon } from "@nzi/contracts";
import { listJobs, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** The Jobs list, one page at a time — see the client-list route. */
export async function GET(request: Request) {
  const { query, issues } = parseListQuery(new URL(request.url).searchParams, jobListSpec);
  if (issues.length > 0) return Response.json({ code: "LIST_QUERY_INVALID", message: issues.join(" ") }, { status: 400 });
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool, organisationId, (db) => listJobs(db, query, { today: todayInLondon() })));
  } catch (error) {
    return apiFailure(error);
  }
}
