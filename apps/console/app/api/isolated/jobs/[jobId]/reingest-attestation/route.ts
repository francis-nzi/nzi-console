import { attestReingestRows } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// RULING-reingest-bulk-attest — one reviewer's attestation over a re-ingest run's rows, exactly as previewed (snapshot.review;
// a reason, x-command-reason, is required). The preparer principal is refused (reviewer ≠ preparer).
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.review.attest_reingest");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["scope.review.attest_reingest"], "jobId">;
    return commandSuccess(await attestReingestRows(isolatedPool(), { runId: body.runId, rows: body.rows, gapKeys: body.gapKeys, jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
