import { updateMilestoneTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a milestone template and its schedule as one versioned change (admin C2) — admin.templates. */
export async function PATCH(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "milestone_template.update");
    const { templateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["milestone_template.update"], "templateId">;
    return commandSuccess(await updateMilestoneTemplate(isolatedPool(), { ...body, templateId: decodeURIComponent(templateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
