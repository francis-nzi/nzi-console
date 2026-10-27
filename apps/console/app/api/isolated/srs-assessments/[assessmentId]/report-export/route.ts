import { exportSrsReport } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// SRS S3, R8: the report export on the record — which completed assessment, which template and version — before the
// browser prints it. Refused for an assessment that is not complete.
export async function POST(request: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.report.export");
    const { assessmentId } = await params;
    const body = await request.json() as { templateKey: string };
    return commandSuccess(await exportSrsReport(isolatedPool(), { assessmentId, templateKey: body.templateKey }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
