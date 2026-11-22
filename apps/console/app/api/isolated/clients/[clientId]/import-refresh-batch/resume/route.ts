import { importBatchDeps } from "../../../../../../lib/importBatchDeps";
import { handleImportBatch } from "../../../../../../lib/importBatchHandler";

export const dynamic = "force-dynamic";

/** Resume a batch whose runner stopped (its lease expired: a deploy or a crash) — `import.refresh_batch` (Admin). */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return handleImportBatch(request, clientId, "resume", importBatchDeps);
}
