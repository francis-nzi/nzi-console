import { V7ImportViewConnectionRefused, type resumeV7ImportBatch, type StaffPrincipal, type startV7ImportBatch } from "@nzi/isolated-backend";
import type { CommandContext, CommandKey } from "@nzi/contracts";
import { PlanDirectoryMissing } from "./importRefreshPlan";
import { IMPORT_SOURCE_UNAVAILABLE } from "./importRefreshHandler";

/**
 * POST /api/isolated/clients/[clientId]/import-refresh-batch (start) and …/resume — the batch from the console
 * (BRIEF-v7-import-server-side-phase-e; RULING-v7-import-phase-e-infra: the runner is in-process). The route hands in its real
 * collaborators; a test hands in fakes. Kept free of `server-only` for that reason.
 *
 *   1. The caller — `import.refresh_batch` (Admin, matrix v16), the write API on, our origin. Refused before anything else.
 *   2. The client is the path's: a body naming another client is refused, never re-pointed. Resume names its run, nothing else.
 *   3. The live source and the plan directory, fail-closed, as the single-job route: unreachable, and no run is started — 503.
 *   4. The command (start: the run and its frozen jobs; resume: the stopped run released), then the runner is started in this
 *      process, after the reply. The reply never waits for the jobs; the panel reads the run's progress.
 */
export type ImportBatchDeps = {
  principal: (request: Request, key: CommandKey) => Promise<StaffPrincipal>;
  context: (request: Request, principal: StaffPrincipal) => CommandContext;
  pool: () => Parameters<typeof startV7ImportBatch>[0];
  /** Throws V7ImportViewConnectionRefused / PlanDirectoryMissing when the batch could read nothing. */
  ready: () => void;
  start: typeof startV7ImportBatch;
  resume: typeof resumeV7ImportBatch;
  /** Starts the runner for the run in this process, detached from the request. */
  kick: (organisationId: string, runId: string) => void;
  success: (outcome: { data: Record<string, unknown>; auditEventId: string; correlationId: string; replayed: boolean }) => Response;
  failure: (error: unknown) => Response;
  log?: (message: string, error: unknown) => void;
};

const invalid = (code: string, message: string, field = "input") =>
  Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.", issues: [{ field, code, message }] }, { status: 422 });

export async function handleImportBatch(request: Request, clientId: string, action: "start" | "resume", deps: ImportBatchDeps): Promise<Response> {
  try {
    const principal = await deps.principal(request, action === "start" ? "import.refreshBatch.start" : "import.refreshBatch.resume");
    const body = await request.json().catch(() => null) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("INVALID", action === "start" ? "A batch names the client." : "A resume names the run.");
    const { clientId: named, ...rest } = body as Record<string, unknown>;
    if (named !== undefined && named !== clientId) return invalid("CLIENT_MISMATCH", "The request names another client than this one.", "clientId");
    try {
      deps.ready();
    } catch (error) {
      if (!(error instanceof V7ImportViewConnectionRefused) && !(error instanceof PlanDirectoryMissing)) throw error;
      (deps.log ?? console.error)("[import-batch] refused before starting", error);
      return Response.json({ code: "IMPORT_SOURCE_UNAVAILABLE", message: IMPORT_SOURCE_UNAVAILABLE }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const context = deps.context(request, principal);
    // Anything else in the body goes to the command, whose closed input refuses it (UNKNOWN_FIELD) — never silently dropped.
    const outcome = action === "start"
      ? await deps.start(deps.pool(), { ...rest, clientId } as Parameters<typeof startV7ImportBatch>[1], context)
      : await deps.resume(deps.pool(), { ...rest, clientId } as Parameters<typeof resumeV7ImportBatch>[1], context);
    // A replayed start (the same key again) starts the runner too: harmless, the lease lets one runner hold the run.
    deps.kick(context.organisationId, outcome.data.runId);
    return deps.success(outcome);
  } catch (error) { return deps.failure(error); }
}
