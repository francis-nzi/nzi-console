import { V7ImportViewConnectionRefused, type commitV7ImportRefresh, type previewV7ImportRefresh, type StaffPrincipal, type V7ImportRefreshOptions, type V7ImportRefreshSource } from "@nzi/isolated-backend";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { PlanDirectoryMissing } from "./importRefreshPlan";

/**
 * POST /api/isolated/jobs/[jobId]/import-refresh — `import.refresh` from the console (BRIEF-v7-import-server-side-phase-c §2).
 * The route hands in its real collaborators; a test hands in fakes. Kept free of `server-only` for that reason.
 *
 * Order, and why:
 *   1. The caller — `import.refresh` (matrix v15), with the write API on and the request from our origin. A caller who may not
 *      refresh is refused before anything else, the source included.
 *   2. The job is the path's: a body naming another job is refused, never silently re-pointed.
 *   3. The live source and the committed plan, fail-closed: no NZI_V7_VIEW_URL, a URL the guard refuses (the console's own
 *      project, no TLS), or no plan directory, and the command never runs — 503, nothing read, nothing written. The detail goes
 *      to the server log, not the screen.
 *   4. The command: `preview` (rolled back; its result is the reply) or `commit` (a reason, and the two fingerprints the
 *      preview showed — the command refuses SUMMARY_MOVED / DECISIONS_MOVED, and the Admin gate when the policy is set).
 */
export type ImportRefreshDeps = {
  principal: (request: Request) => Promise<StaffPrincipal>;
  context: (request: Request, principal: StaffPrincipal) => CommandContext;
  pool: () => Parameters<typeof previewV7ImportRefresh>[0];
  source: () => V7ImportRefreshSource;
  /** The committed plan, passed explicitly (`importRefreshPlan.ts`); may throw PlanDirectoryMissing. */
  options: (jobId: string, principal: StaffPrincipal) => Promise<V7ImportRefreshOptions>;
  preview: typeof previewV7ImportRefresh;
  commit: typeof commitV7ImportRefresh;
  success: (outcome: { data: Record<string, unknown>; auditEventId: string; correlationId: string; replayed: boolean }) => Response;
  failure: (error: unknown) => Response;
  log?: (message: string, error: unknown) => void;
};

export const IMPORT_SOURCE_UNAVAILABLE = "The previous system's records cannot be reached from the console just now, so nothing was read and nothing changed.";
const invalid = (code: string, message: string, field = "input") =>
  Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.", issues: [{ field, code, message }] }, { status: 422 });

export async function handleImportRefresh(request: Request, jobId: string, deps: ImportRefreshDeps): Promise<Response> {
  try {
    const principal = await deps.principal(request);
    const body = await request.json().catch(() => null) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("INVALID", "A refresh is a preview or a commit.");
    const { jobId: named, ...rest } = body as Record<string, unknown>;
    if (named !== undefined && named !== jobId) return invalid("JOB_MISMATCH", "The request names another job than this one.", "jobId");
    let source: V7ImportRefreshSource;
    let options: V7ImportRefreshOptions;
    try {
      source = deps.source();
      options = await deps.options(jobId, principal);
    } catch (error) {
      if (!(error instanceof V7ImportViewConnectionRefused) && !(error instanceof PlanDirectoryMissing)) throw error;
      (deps.log ?? console.error)("[import-refresh] refused before reading", error);
      return Response.json({ code: "IMPORT_SOURCE_UNAVAILABLE", message: IMPORT_SOURCE_UNAVAILABLE }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const context = deps.context(request, principal);
    if (rest.mode === "commit") {
      const input = { ...rest, jobId } as Extract<CommandInputMap["import.refresh"], { mode: "commit" }>;
      return deps.success(await deps.commit(deps.pool(), source, input, context, options));
    }
    // Anything that is not a commit is validated as a preview: an unknown mode or key is the command's own refusal.
    const input = { ...rest, jobId } as Extract<CommandInputMap["import.refresh"], { mode: "preview" }>;
    const preview = await deps.preview(deps.pool(), source, input, context, options);
    return Response.json({ data: preview }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return deps.failure(error); }
}
