import { createClientSite } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The client-workspace entry to the one canonical `site.create` (NZC-070); the job
// workspace reaches the same command through /api/isolated/jobs/[jobId]/sites.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "site.create");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["site.create"], "clientId" | "jobId">;
    return commandSuccess(await createClientSite(isolatedPool(), { ...body, clientId, jobId: null }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
