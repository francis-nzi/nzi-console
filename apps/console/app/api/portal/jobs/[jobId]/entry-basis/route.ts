import { assertPortalJobAccess, readJobEntryBasis, withTenantRead } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * Data entry D1 (R4), for the client's own entry form: the basis each category opens on — their last choice, else the
 * organisation's default — and their currency. Settings only: no figures, no staff identity (who set a default is not sent).
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const basis = await withTenantRead(isolatedPool(), user.organisationId, async (db) => {
      await assertPortalJobAccess(db, user, jobId);
      return readJobEntryBasis(db, user.organisationId, jobId);
    });
    return Response.json(basis, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
