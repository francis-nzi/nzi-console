import { readV7ImportMapping, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { commandFailure } from "../../../../../../lib/commandResponse";
import { handleImportMapping } from "../../../../../../lib/importMappingHandler";
import { importRefreshPlanOptions } from "../../../../../../lib/importRefreshPlan";
import { liveImportViewSource } from "../../../../../../lib/importViewSource";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The job's mapping view: each row of the previous system against its intended console mapping — `import.refresh` to read. */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return handleImportMapping(request, jobId, {
    principal: async (req) => { const principal = await currentStaff(req); requireCapability(principal, "import.refresh"); return principal; },
    pool: isolatedPool, source: () => liveImportViewSource(),
    options: async (id, principal) => importRefreshPlanOptions(id, await withTenantRead(isolatedPool(), principal.organisationId, async (db) =>
      (await db.query<{ legacy_job_number: string | null }>(`SELECT legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`,
        [principal.organisationId, id])).rows[0]?.legacy_job_number ?? null)),
    read: readV7ImportMapping, failure: commandFailure,
  });
}
