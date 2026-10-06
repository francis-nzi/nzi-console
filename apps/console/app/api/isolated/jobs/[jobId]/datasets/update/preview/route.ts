import { previewJobDatasetUpdate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The preview: the write's own code, rolled back — so it shows exactly what Update would do. Held to the same permission.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.datasets.update");
    const { jobId } = await params;
    const body = await request.json() as Pick<CommandInputMap["job.datasets.update"], "series" | "resolutions">;
    return Response.json(await previewJobDatasetUpdate(isolatedPool(), { series: body.series, resolutions: body.resolutions ?? [], jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
