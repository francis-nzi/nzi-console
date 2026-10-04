import { createClientSite } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { afterSaveLocate } from "../../../../../lib/geolocate";

export const dynamic = "force-dynamic";

// The client-workspace entry to the one canonical `site.create` (NZC-070); the job
// workspace reaches the same command through /api/isolated/jobs/[jobId]/sites.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "site.create");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["site.create"], "clientId" | "jobId">;
    const context = commandContext(request, principal);
    const outcome = await createClientSite(isolatedPool(), { ...body, clientId, jobId: null }, context);
    // CLIENT-04: located after the save, best effort — the response says what happened; the save stands either way.
    const location = await afterSaveLocate("site", isolatedPool(), outcome.data.siteId, context);
    return commandSuccess({ ...outcome, data: { ...outcome.data, location } });
  } catch (error) {
    return commandFailure(error);
  }
}
