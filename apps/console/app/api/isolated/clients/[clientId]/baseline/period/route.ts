import { moveClientBaselinePeriod } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Addendum B.4 — the client's baseline period moved with its baseline-year job: client.update with the record as held and only
// the period changed. A governed re-baseline when the baseline has figures, so the reason travels in x-command-reason.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.update");
    const { clientId } = await params;
    const body = await request.json() as { periodStart: string; periodEnd: string; expectedVersion?: number };
    return commandSuccess(await moveClientBaselinePeriod(isolatedPool(), {
      clientId, periodStart: body.periodStart, periodEnd: body.periodEnd, ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
    }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
