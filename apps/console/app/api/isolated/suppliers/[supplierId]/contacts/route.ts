import { addSupplierContact } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a contact at a supplier (admin E4) — admin.lookups; sealed on write (E-Q6), and the result names which fields, never their values. */
export async function POST(request: Request, { params }: { params: Promise<{ supplierId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "supplier.contact.add");
    const { supplierId } = await params;
    const body = await request.json() as Omit<CommandInputMap["supplier.contact.add"], "supplierId">;
    return commandSuccess(await addSupplierContact(isolatedPool(), { ...body, supplierId: decodeURIComponent(supplierId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
