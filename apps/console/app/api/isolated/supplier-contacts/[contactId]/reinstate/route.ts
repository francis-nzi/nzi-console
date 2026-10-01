import { reinstateSupplierContact } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a supplier contact (admin E4) — admin.lookups; an erased contact cannot be. */
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.contact.reinstate");
    const { contactId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.contact.reinstate"], "contactId">;
    return commandSuccess(await reinstateSupplierContact(isolatedPool(), { ...body, contactId: decodeURIComponent(contactId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
