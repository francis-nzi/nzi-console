import { createMilestoneTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a milestone template with its schedule (admin C2) — admin.templates, through the command runner. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "milestone_template.create");
    const body = await request.json() as CommandInputMap["milestone_template.create"];
    return commandSuccess(await createMilestoneTemplate(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
