import { updateClientContact } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.contact.update");
    const { contactId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.contact.update"], "contactId">;
    return commandSuccess(await updateClientContact(isolatedPool(), { ...body, contactId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
