import { retrieveGrounding, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Grounding — cited candidates, or an explicit "no grounded answer".
 *
 * **Retrieval only. There is no model here**, and the absence is the feature: Phase 1 adds
 * generation on top of this result, and keeping the two apart is what lets the citation and
 * abstention rules be tested before any of it exists.
 *
 * Read-only by construction — GET, no command, nothing written. The assistant's entire write
 * surface is a knowledge-library draft, which goes through the approval-gated command in 0a.
 */
export async function GET(request: Request) {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const question = new URL(request.url).searchParams.get("q") ?? "";
    const result = await withTenantRead(pool, organisationId, (db) => retrieveGrounding(question, { db }));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiFailure(error); }
}
