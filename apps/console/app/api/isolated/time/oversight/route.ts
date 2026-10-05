import { readTimeOversight, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";
import { timePeriodFrom } from "../../../../lib/timePeriodParam";

export const dynamic = "force-dynamic";

/** Oversight (Time PR B): the period's jobs against their budget and fee — time.view; money for finance.view only. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const parsed = timePeriodFrom(new URL(request.url));
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    const oversight = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readTimeOversight(db, principal, parsed.period));
    return Response.json({ oversight }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
