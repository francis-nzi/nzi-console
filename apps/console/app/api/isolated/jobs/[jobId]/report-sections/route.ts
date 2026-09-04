import { getReportSectionsEditorScreen, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// R4 — the working report-sections editor screen for a job's Report & publish
// stage: the ordered sections plus live (unreviewed) job figures for token
// previews. Read-only; edits go through the report.section.* commands.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const screen = await withTenantRead(pool, organisationId, (db) => getReportSectionsEditorScreen(db, jobId));
    if (!screen) return Response.json({ code: "NOT_FOUND", message: "Report sections are available only for CRP jobs." }, { status: 404 });
    return Response.json(screen, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
