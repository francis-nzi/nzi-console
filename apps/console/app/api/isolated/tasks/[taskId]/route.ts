import { updateTask } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit, reschedule or reassign a task (task.update). Body: { expectedVersion, title?, notes?, dueDate?, assignedUserId? } — only the fields given change. */
export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "task.update");
    const { taskId } = await params;
    const body = await request.json() as Omit<CommandInputMap["task.update"], "taskId">;
    const input: CommandInputMap["task.update"] = { taskId, expectedVersion: Number(body.expectedVersion) };
    if (body.title !== undefined) input.title = String(body.title);
    if (body.notes !== undefined) input.notes = body.notes;
    if (body.dueDate !== undefined) input.dueDate = body.dueDate;
    if (body.assignedUserId !== undefined) input.assignedUserId = String(body.assignedUserId);
    return commandSuccess(await updateTask(isolatedPool(), input, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
