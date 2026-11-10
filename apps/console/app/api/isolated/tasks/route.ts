import { createTask } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// CRM tasks (BRIEF-crm-control-room-p3-tasks): staff only — there is no portal route to a task. The Control Room reads them.

/** Add a task (task.create). Body: { title, notes?, dueDate?, jobId?, clientId?, assignedUserId? } — for the caller unless someone else is named. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "task.create");
    const body = await request.json() as CommandInputMap["task.create"];
    return commandSuccess(await createTask(isolatedPool(), {
      title: String(body.title ?? ""), notes: body.notes ?? null, dueDate: body.dueDate ?? null, jobId: body.jobId ?? null, clientId: body.clientId ?? null, assignedUserId: body.assignedUserId ?? null,
    }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
