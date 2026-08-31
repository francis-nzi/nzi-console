import { voidSpendImportBatch } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// S1.1 — audited soft-void of a bulk import batch (any `job_emission_sources`
// carrying `import_batch_id`). Only rows still pending and not yet synced are
// voided; the rest are skipped and reported. Reuses the B4 batch-void command.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "emission.source.import.void");
    const { jobId } = await params;
    const body = (await request.json()) as { batchId?: string };
    return commandSuccess(await voidSpendImportBatch(isolatedPool(), { jobId, batchId: body.batchId ?? "" }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
