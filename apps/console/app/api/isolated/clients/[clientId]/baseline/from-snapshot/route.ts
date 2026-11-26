import { useSnapshotAsBaseline } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// 0238 rule 3 — "Use J… figures as the baseline". The figures are read from the snapshot on the server; only its id is sent.
// On a baseline that already has figures it is the governed re-baseline, so the reason travels in x-command-reason.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.baseline.useSnapshot");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.baseline.useSnapshot"], "clientId">;
    return commandSuccess(await useSnapshotAsBaseline(isolatedPool(), { snapshotId: body.snapshotId, expectedVersion: body.expectedVersion, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
