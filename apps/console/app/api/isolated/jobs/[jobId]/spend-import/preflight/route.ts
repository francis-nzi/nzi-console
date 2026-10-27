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
    // In the `{ data }` envelope the panel's `postBrowserCommand` reads as success (D3: found driving the preview — a bare body
    // was read as a failure, so the preview never showed).
    if (!issued) return Response.json({ data: { kind: "blocked", reason: "job-not-found", message: "The job has no reporting period set, so nothing can be imported yet." } }, { status: 200 });
    return Response.json({ data: await previewSpendImport(isolatedPool(), organisationId, issued.identity, rows, SPEND_IMPORT_TEMPLATE_VERSION) });
  } catch (error) {
    return commandFailure(error);
  }
}
