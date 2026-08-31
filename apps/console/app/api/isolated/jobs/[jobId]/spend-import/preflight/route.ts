import { issueSpendImportIdentity, previewSpendImport, SPEND_IMPORT_TEMPLATE_VERSION } from "@nzi/isolated-backend";
import type { SpendImportRow } from "@nzi/contracts";
import { IMPORT_MAX_ROWS } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandFailure } from "../../../../../../lib/commandResponse";
import { isolatedPool, requireIsolatedApiContext } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    await requireCommandPrincipal(request, "emission.source.import.commit");
    const { jobId } = await params;
    const { organisationId } = requireIsolatedApiContext();
    const body = (await request.json()) as { rows?: SpendImportRow[] };
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, IMPORT_MAX_ROWS) : [];
    const issued = await issueSpendImportIdentity(isolatedPool(), organisationId, jobId, process.env.NZI_CONSOLE_SESSION_SECRET);
    if (!issued) return Response.json({ kind: "blocked", reason: "job-not-found", message: "The job is not a configured CRP job." }, { status: 200 });
    return Response.json(await previewSpendImport(isolatedPool(), organisationId, issued.identity, rows, SPEND_IMPORT_TEMPLATE_VERSION));
  } catch (error) {
    return commandFailure(error);
  }
}
