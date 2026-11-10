import { completeTask } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Mark a task done (task.complete). Body: { expectedVersion }. */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "task.complete");
    const { taskId } = await params;
    const body = await request.json() as { expectedVersion?: number };
    return commandSuccess(await completeTask(isolatedPool(), { taskId, expectedVersion: Number(body.expectedVersion) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
