import { updateMessageTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a message template's subject and body (admin F1) — admin.templates, against its version; the key never changes. */
export async function PATCH(request: Request, { params }: { params: Promise<{ templateKey: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "message_template.update");
    const { templateKey } = await params;
    const body = await request.json() as Omit<CommandInputMap["message_template.update"], "templateKey">;
    return commandSuccess(await updateMessageTemplate(isolatedPool(), { ...body, templateKey: decodeURIComponent(templateKey) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
