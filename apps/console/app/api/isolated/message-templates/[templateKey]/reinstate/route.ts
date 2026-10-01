import { reinstateMessageTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Use a message template again (admin F1) — admin.templates. */
export async function POST(request: Request, { params }: { params: Promise<{ templateKey: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "message_template.reinstate");
    const { templateKey } = await params;
    const body = await request.json() as Omit<CommandInputMap["message_template.reinstate"], "templateKey">;
    return commandSuccess(await reinstateMessageTemplate(isolatedPool(), { ...body, templateKey: decodeURIComponent(templateKey) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
