import { logTimeEntry, readMyTimeEntries, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** My time (TIME PR A): one's own entries between `from` and `to` (inclusive days), under time.log. Hours only, never rates. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const url = new URL(request.url);
    const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
    if (!DAY.test(from) || !DAY.test(to) || from > to) return Response.json({ error: "Give the period as from and to days, from first." }, { status: 400 });
    const entries = await withTenantRead(isolatedPool(), principal.organisationId, (db) =>
      readMyTimeEntries(db, principal, { from, to, includeVoided: url.searchParams.get("voided") === "1" }));
    return Response.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** Log one's own time against a job (time.entry.log) — through the command runner. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "time.entry.log");
    const body = await request.json() as CommandInputMap["time.entry.log"];
    return commandSuccess(await logTimeEntry(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
