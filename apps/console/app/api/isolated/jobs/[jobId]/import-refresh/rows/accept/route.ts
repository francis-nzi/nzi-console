import { acceptV7ImportRows, type V7ImportRowsAcceptInput } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * The import rows modal's accept (BRIEF-v7-import-rows-modal §B): many rows' decisions in one request — each the existing
 * `import.decision.set` command (import.manage), keyed by the row id, under its own idempotency key and audit. The caller is that
 * command's principal, checked before anything is written; the job is the path's.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const principal = await requireCommandPrincipal(request, "import.decision.set");
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body && body.jobId !== undefined && body.jobId !== jobId) {
      return Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.", issues: [{ field: "jobId", code: "JOB_MISMATCH", message: "The request names another job than this one." }] }, { status: 422 });
    }
    const data = await acceptV7ImportRows(isolatedPool(), { ...(body ?? {}), jobId } as V7ImportRowsAcceptInput, commandContext(request, principal));
    return Response.json({ data }, { status: data.written.length ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return commandFailure(error); }
}
