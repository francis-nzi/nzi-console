import { getSrsReport, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * SRS S3 — a client's readiness report, as its template draws it (srs.manage on this client). GET only: drawing the report
 * writes nothing; exporting it is the audited `srs.report.export` command, run as the PDF is printed.
 * `?assessment=` names a completed assessment (the latest otherwise); `?template=` names the template (UK SRS otherwise).
 */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { clientId } = await params;
    const query = new URL(request.url).searchParams;
    const report = await withTenantRead(isolatedPool(), principal.organisationId, (db) =>
      getSrsReport(db, principal, { clientId, assessmentId: query.get("assessment"), templateKey: query.get("template") ?? "uk-srs" }));
    return Response.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error as Error); }
}
