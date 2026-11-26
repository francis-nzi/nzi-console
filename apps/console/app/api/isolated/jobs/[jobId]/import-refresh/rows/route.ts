import { readV7ImportRows, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { commandFailure } from "../../../../../../lib/commandResponse";
import { liveRowFiguresClient } from "../../../../../../lib/driftCheck";
import { handleImportMapping } from "../../../../../../lib/importMappingHandler";
import { importRefreshPlanOptions } from "../../../../../../lib/importRefreshPlan";
import { liveImportViewSource } from "../../../../../../lib/importViewSource";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * The import rows modal's read (BRIEF-v7-import-rows-modal §A): every row of the previous system for the job, its candidates and
 * their verdicts — `import.refresh` to read, fail-closed on the source exactly as the refresh. Read and rolled back; nothing stored.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return handleImportMapping(request, jobId, {
    principal: async (req) => { const principal = await currentStaff(req); requireCapability(principal, "import.refresh"); return principal; },
    pool: isolatedPool, source: () => liveImportViewSource(),
    options: async (id, principal) => ({ ...importRefreshPlanOptions(id, await withTenantRead(isolatedPool(), principal.organisationId, async (db) =>
      (await db.query<{ legacy_job_number: string | null }>(`SELECT legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`,
        [principal.organisationId, id])).rows[0]?.legacy_job_number ?? null)),
      // A job over two calendar years: each row judged against the previous system's own figure (endpoint 2), priced by month.
      rowFigures: liveRowFiguresClient() }),
    read: readV7ImportRows, failure: commandFailure,
  });
}
