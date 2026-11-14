import { AuthorizationError, readImportPolicy, setOrganisationImportPolicy, withTenantRead } from "@nzi/isolated-backend";
import { grantsAllow, type CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * The organisation's import policy (0231): whether committing an import refresh needs an Admin. Off until set. Read by anyone who
 * may refresh (import.refresh) or set it (admin.settings) — the refresh panel says before a commit is tried whether it needs an
 * Admin. Fails closed: an unreadable policy is an error, never "off".
 */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    if (!grantsAllow(principal.capabilities, "import.refresh") && !grantsAllow(principal.capabilities, "admin.settings")) throw new AuthorizationError("import.refresh");
    const policy = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readImportPolicy(db, principal.organisationId));
    return Response.json(policy, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** Require an Admin to commit a refresh, or not — admin.settings, a reason in `x-command-reason`; audited with the old and new answer. */
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.importPolicy.set");
    const body = await request.json() as CommandInputMap["organisation.importPolicy.set"];
    return commandSuccess(await setOrganisationImportPolicy(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
