import { summariseV7JobFromViews, uploadV7ImportSummary, V7ImportViewConnectionRefused, withTenantRead, withTenantWrite } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { IMPORT_SOURCE_UNAVAILABLE } from "../../../../../../lib/importRefreshHandler";
import { liveImportViewPool } from "../../../../../../lib/importViewSource";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Store the job's current summary so its exceptions can be resolved here (BRIEF-v7-import-server-side-phase-c §3: "reuse the
 * Phase 2 resolve controls"). A decision is saved against a row of the job's latest stored summary, and a refresh preview stores
 * nothing — so a resolver first stores the summary as the views give it now, through the existing upload command
 * (`import.summary.upload`, import.manage: Admin). It writes the summary and its audit only; nothing touches the job's rows.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const principal = await requireCommandPrincipal(request, "import.summary.upload");
    let viewPool: ReturnType<typeof liveImportViewPool>;
    try { viewPool = liveImportViewPool(); } catch (error) {
      if (!(error instanceof V7ImportViewConnectionRefused)) throw error;
      console.error("[import-refresh] the import's view source is refused", error);
      return Response.json({ code: "IMPORT_SOURCE_UNAVAILABLE", message: IMPORT_SOURCE_UNAVAILABLE }, { status: 503 });
    }
    const legacyJobNumber = await withTenantRead(isolatedPool(), principal.organisationId, async (db) =>
      (await db.query<{ legacy_job_number: string | null }>(`SELECT legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`,
        [principal.organisationId, jobId])).rows[0]?.legacy_job_number ?? null);
    if (!legacyJobNumber) return Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.",
      issues: [{ field: "jobId", code: "NOT_A_V7_JOB", message: "Only a job imported from the previous system has an import summary." }] }, { status: 422 });
    // The server-side summary (Phase A): read in one snapshot, compared as the chain sees it, rolled back on the console side.
    const summary = await withTenantWrite(isolatedPool(), principal.organisationId, (db) =>
      summariseV7JobFromViews(db, viewPool, { organisationId: principal.organisationId, legacyJobNumber }));
    return commandSuccess(await uploadV7ImportSummary(isolatedPool(), { jobId, summary }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
