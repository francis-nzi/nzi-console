import { deactivateSupplierContact } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a supplier contact (admin E4) — never deleted (erasure is the DSAR path); the reason is required. */
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.contact.deactivate");
    const { contactId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.contact.deactivate"], "contactId">;
    return commandSuccess(await deactivateSupplierContact(isolatedPool(), { ...body, contactId: decodeURIComponent(contactId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
