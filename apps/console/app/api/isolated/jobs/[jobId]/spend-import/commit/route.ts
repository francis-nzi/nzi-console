import { commitSpendImport, issueSpendImportIdentity } from "@nzi/isolated-backend";
import type { SpendImportRow } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool, requireIsolatedApiContext } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "emission.source.import.commit");
    const { jobId } = await params;
    const { organisationId } = requireIsolatedApiContext();
    const secret = process.env.NZI_CONSOLE_SESSION_SECRET;
    const body = (await request.json()) as { rows?: SpendImportRow[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const issued = await issueSpendImportIdentity(isolatedPool(), organisationId, jobId, secret);
    if (!issued) return commandFailure(new Error("The job is not a configured CRP job."));
    return commandSuccess(await commitSpendImport(isolatedPool(), { jobId, token: issued.token, rows }, commandContext(request, principal), secret));
  } catch (error) {
    return commandFailure(error);
  }
}
