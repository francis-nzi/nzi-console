import { readOrganisationBank, setOrganisationBank, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * The organisation's bank details (Q2) — admin.settings only, refused without it. Masked unless `?reveal=1`: the
 * screen's explicit "Show". Never cached.
 */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const reveal = new URL(request.url).searchParams.get("reveal") === "1";
    const bank = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readOrganisationBank(db, principal, principal.organisationId, { reveal }));
    return Response.json(bank, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authFailure(error); }
}

/** Set or clear the bank details — admin.settings, a reason in `x-command-reason`; the payload names fields, never values. */
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.bank.set");
    const body = await request.json() as CommandInputMap["organisation.bank.set"];
    return commandSuccess(await setOrganisationBank(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
