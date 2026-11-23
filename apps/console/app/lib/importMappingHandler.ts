import { V7ImportViewConnectionRefused, type readV7ImportMapping, type StaffPrincipal, type V7ImportRefreshOptions, type V7ImportRefreshSource } from "@nzi/isolated-backend";
import { IMPORT_SOURCE_UNAVAILABLE } from "./importRefreshHandler";
import { PlanDirectoryMissing } from "./importRefreshPlan";

/**
 * GET /api/isolated/jobs/[jobId]/import-refresh/mapping — the job's mapping view (BRIEF-v7-import-rowid-match-and-mapping-view,
 * Part 2). A read: what the refresh preview reads, laid out row by row, rolled back. No command, no audit, nothing stored.
 *
 *   1. The caller: `import.refresh`, as the panel's own state read — refused before anything is read.
 *   2. The live source and the committed plan, fail-closed exactly as the refresh: 503, nothing read.
 *   3. The read.
 * The route hands in its real collaborators; a test hands in fakes.
 */
export type ImportMappingDeps = {
  principal: (request: Request) => Promise<StaffPrincipal>;
  pool: () => Parameters<typeof readV7ImportMapping>[0];
  source: () => V7ImportRefreshSource;
  options: (jobId: string, principal: StaffPrincipal) => Promise<V7ImportRefreshOptions>;
  read: typeof readV7ImportMapping;
  failure: (error: unknown) => Response;
  log?: (message: string, error: unknown) => void;
};

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function handleImportMapping(request: Request, jobId: string, deps: ImportMappingDeps): Promise<Response> {
  try {
    const principal = await deps.principal(request);
    let source: V7ImportRefreshSource;
    let options: V7ImportRefreshOptions;
    try {
      source = deps.source();
      options = await deps.options(jobId, principal);
    } catch (error) {
      if (!(error instanceof V7ImportViewConnectionRefused) && !(error instanceof PlanDirectoryMissing)) throw error;
      (deps.log ?? console.error)("[import-mapping] refused before reading", error);
      return Response.json({ code: "IMPORT_SOURCE_UNAVAILABLE", message: IMPORT_SOURCE_UNAVAILABLE }, { status: 503, headers: NO_STORE });
    }
    const mapping = await deps.read(deps.pool(), source, principal, jobId, { basePlan: options.basePlan });
    return Response.json({ data: mapping }, { headers: NO_STORE });
  } catch (error) { return deps.failure(error); }
}
