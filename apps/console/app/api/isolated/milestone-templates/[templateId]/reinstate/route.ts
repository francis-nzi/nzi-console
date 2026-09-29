import { reinstateMilestoneTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a milestone template (admin C2) — back into the pickers; its name is still its own. */
export async function POST(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "milestone_template.reinstate");
    const { templateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["milestone_template.reinstate"], "templateId">;
    return commandSuccess(await reinstateMilestoneTemplate(isolatedPool(), { ...body, templateId: decodeURIComponent(templateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
