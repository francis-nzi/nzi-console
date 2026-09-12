import { deactivateClientContact } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Deactivate, never delete: the contact and its history stay on the record.
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.contact.deactivate");
    const { contactId } = await params;
    const body = await request.json() as { expectedVersion: number };
    return commandSuccess(await deactivateClientContact(isolatedPool(), { contactId, expectedVersion: body.expectedVersion }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
