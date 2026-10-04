import { readTimeUtilisation, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";
import { timePeriodFrom } from "../../../../lib/timePeriodParam";

export const dynamic = "force-dynamic";

/** Utilisation (Time PR B, ⚑8): logged hours against weekly capacity — time.view across all clients. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const parsed = timePeriodFrom(new URL(request.url));
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    const utilisation = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readTimeUtilisation(db, principal, parsed.period));
    return Response.json({ utilisation }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
