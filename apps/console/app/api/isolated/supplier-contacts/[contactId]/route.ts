import { updateSupplierContact } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a supplier contact (admin E4) — admin.lookups; re-sealed on write, and the result names which fields changed, never to what. */
export async function PATCH(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.contact.update");
    const { contactId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.contact.update"], "contactId">;
    return commandSuccess(await updateSupplierContact(isolatedPool(), { ...body, contactId: decodeURIComponent(contactId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
