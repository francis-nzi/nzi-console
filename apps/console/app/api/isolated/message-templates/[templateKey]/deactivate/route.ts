import { deactivateMessageTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Go back to a message's built-in wording (admin F1) — the organisation's own is kept; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ templateKey: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "message_template.deactivate");
    const { templateKey } = await params;
    const body = await request.json() as Omit<CommandInputMap["message_template.deactivate"], "templateKey">;
    return commandSuccess(await deactivateMessageTemplate(isolatedPool(), { ...body, templateKey: decodeURIComponent(templateKey) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
