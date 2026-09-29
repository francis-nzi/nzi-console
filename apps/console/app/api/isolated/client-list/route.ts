import { clientListSpec, parseListQuery } from "@nzi/contracts";
import { listClients, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * The Clients list, one page at a time (docs/LIST_PARITY_DESIGN.md). The query is parsed against the list's
 * whitelist; anything it does not understand is refused rather than coerced, because the only URL this should
 * receive is one `listQueryToSearchParams` wrote.
 */
export async function GET(request: Request) {
  const { query, issues } = parseListQuery(new URL(request.url).searchParams, clientListSpec);
  if (issues.length > 0) return Response.json({ code: "LIST_QUERY_INVALID", message: issues.join(" ") }, { status: 400 });
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool, organisationId, (db) => listClients(db, query)));
  } catch (error) {
    return apiFailure(error);
  }
}
