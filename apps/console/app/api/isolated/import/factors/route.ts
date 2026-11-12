import { listV7ImportFactorOptions, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** Import workbench, Phase 2: the factors a category offers the mapping picker — the rules the save applies. import.manage. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "import.manage");
    const category = new URL(request.url).searchParams.get("category") ?? "";
    const found = await withTenantRead(isolatedPool(), principal.organisationId, (db) => listV7ImportFactorOptions(db, principal.organisationId, category));
    if (!found) return Response.json({ error: "Unknown category." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    return Response.json(found, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
