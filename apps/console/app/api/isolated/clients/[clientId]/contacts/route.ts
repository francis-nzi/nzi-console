import { contactsWithRole, createClientContact, listClientContacts, withTenantRead } from "@nzi/isolated-backend";
import { clientContactRoles, type ClientContactRole, type CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** The client's active contacts; `?role=` narrows to one downstream role (e.g. portal_candidate for the invite picker). */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const role = new URL(request.url).searchParams.get("role");
    if (role !== null && !(clientContactRoles as readonly string[]).includes(role)) return Response.json({ code: "INVALID_ROLE", message: "Unknown contact role." }, { status: 422 });
    const { pool, organisationId } = requireIsolatedApiContext();
    const contacts = await withTenantRead(pool, organisationId, (db) => role ? contactsWithRole(db, clientId, role as ClientContactRole) : listClientContacts(db, clientId));
    return Response.json({ contacts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.contact.create");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.contact.create"], "clientId">;
    return commandSuccess(await createClientContact(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
