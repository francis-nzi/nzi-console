import { setDefaultMilestoneTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Make a template the organisation's default (admin C2) — the old default is cleared in the same transaction; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "milestone_template.set_default");
    const { templateId } = await params;
    const body = await request.json() as Omit<CommandInputMap["milestone_template.set_default"], "templateId">;
    return commandSuccess(await setDefaultMilestoneTemplate(isolatedPool(), { ...body, templateId: decodeURIComponent(templateId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
