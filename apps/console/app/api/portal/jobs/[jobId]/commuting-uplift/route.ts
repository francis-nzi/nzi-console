import { assertPortalJobAccess, readJobCommutingUplift, savePortalSiteHeadcount, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * Employee commuting (3.7) uplift, for the client: each site's headcount, the commuting rows already entered, the response rate and the
 * uplift headcount it can agree. Figures in tCO2e are not sent - the client sees headcounts and a rate, never the calculation.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const view = await withTenantRead(isolatedPool(), user.organisationId, async (db) => {
      await assertPortalJobAccess(db, user, jobId);
      return readJobCommutingUplift(db, user.organisationId, jobId);
    });
    return Response.json({
      ...view,
      sites: view.sites.map(({ sampledTco2e: _sampled, upliftedTco2e: _uplifted, savedBy: _by, ...site }) => site),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}

/** The client's entry of a site's headcount and uplift choice (portal.site.headcount.save). */
export async function PUT(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal.site.headcount.save"], "jobId">;
    return commandSuccess(await savePortalSiteHeadcount(isolatedPool(), { ...body, jobId }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
