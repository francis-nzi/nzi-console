import { deactivateMilestoneTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a milestone template (admin C2) — never the default, never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "milestone_template.deactivate");
    const { templateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["milestone_template.deactivate"], "templateId">;
    return commandSuccess(await deactivateMilestoneTemplate(isolatedPool(), { ...body, templateId: decodeURIComponent(templateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
