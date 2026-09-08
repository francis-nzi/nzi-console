import { getPortalAssuredDashboard, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../lib/portalSession";
import { isPortalAssuredDashboard } from "../../../../../portal/jobs/[jobId]/portalAnalyticsValidation";

export const dynamic = "force-dynamic";

// Client portal Phase 2 · A1 — the assured baseline (§0): per-scope and
// per-category/site breakdown of the latest PUBLISHED report snapshot, plus the
// prior years' trend. Never sourced from draft rows. A1's dashboard aggregates
// this; A2's lever targeting reads the same breakdown.
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const dashboard = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getPortalAssuredDashboard(db, { portalUserId: user.userId, clientId: user.clientId, jobId }),
    );
    if (!isPortalAssuredDashboard(dashboard)) {
      return Response.json(
        { code: "INVALID_ANALYTICS_EVIDENCE", message: "The assured analytics evidence could not be verified." },
        { status: 502, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return Response.json(dashboard, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}
