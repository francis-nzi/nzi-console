import { commitV7ImportRefresh, previewV7ImportRefresh, refreshV7ImportFastPath, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { importRefreshPlanOptions } from "../../../../../lib/importRefreshPlan";
import { handleImportRefresh } from "../../../../../lib/importRefreshHandler";
import { readImportRefreshState } from "../../../../../lib/importRefreshState";
import { liveImportViewSource } from "../../../../../lib/importViewSource";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The job's refresh panel state (BRIEF-v7-import-server-side-phase-c §3) — `import.refresh` to read at all. */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const principal = await currentStaff(request);
    requireCapability(principal, "import.refresh");
    return Response.json(await readImportRefreshState(principal, jobId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** Preview (rolled back) or commit (a reason in `x-command-reason`, and the preview's two fingerprints) — `import.refresh`. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return handleImportRefresh(request, jobId, {
    principal: (req) => requireCommandPrincipal(req, "import.refresh"),
    context: commandContext, pool: isolatedPool, source: () => liveImportViewSource(),
    // The committed plan, passed explicitly from the repository's plan directory (importRefreshPlan.ts says why).
    options: async (id, principal) => importRefreshPlanOptions(id, await withTenantRead(isolatedPool(), principal.organisationId, async (db) =>
      (await db.query<{ legacy_job_number: string | null }>(`SELECT legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`,
        [principal.organisationId, id])).rows[0]?.legacy_job_number ?? null)),
    preview: previewV7ImportRefresh, commit: commitV7ImportRefresh, fastPath: refreshV7ImportFastPath, success: commandSuccess, failure: commandFailure,
  });
}
