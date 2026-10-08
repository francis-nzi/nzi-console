import { setJobSiteInclusion } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Include a client's site in this job's report, or leave it out (Phase 3a, 0161). The body is `{ included, expectedVersion }`;
 * leaving a site out needs a reason, sent as `x-command-reason`. Refused while the job uses the site (SITE_IN_USE).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ jobId: string; siteId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.site.setInclusion");
    const { jobId, siteId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.site.setInclusion"], "jobId" | "siteId">;
    return commandSuccess(await setJobSiteInclusion(isolatedPool(), {
      included: body.included, expectedVersion: body.expectedVersion,
      jobId: decodeURIComponent(jobId), siteId: decodeURIComponent(siteId),
    }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
