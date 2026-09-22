import { readJobEmissions } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * One job's live emissions (NZC-144).
 *
 * `readJobEmissions` opens its own tenant-scoped read, so this route passes the organisation from the
 * request context and never a job id alone — the same confinement every other read on this surface has.
 *
 * `siteId` narrows the headline, the bands and the category totals. The site breakdown it returns is
 * deliberately never narrowed, because the site tabs show every site's count while one of them is selected.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const siteId = new URL(request.url).searchParams.get("siteId");
    return Response.json(await readJobEmissions(pool, {
      organisationId,
      jobId,
      // "all" is the tab, not a site: it means unnarrowed.
      siteId: siteId === null || siteId === "all" ? null : siteId,
    }));
  } catch (error) { return apiFailure(error); }
}
